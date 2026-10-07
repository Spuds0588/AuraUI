"""A minimal RFC 6455 WebSocket client built on the Python standard library.

AuraUI's Python client has no dependencies on purpose: an agent author should be able to
``pip install`` nothing, or vendor this file, and still talk to the bridge. That rules out
the ``websockets`` package, so the handshake and frame codec live here.

Scope: client role only, text messages only. It masks outgoing frames as RFC 6455 requires,
reassembles fragmented messages, answers pings, and reports the peer's close code. It does
not implement extensions or binary payloads, because the AuraUI protocol is JSON text.
"""

from __future__ import annotations

import base64
import hashlib
import os
import socket
import ssl
import struct
import threading
from typing import Optional
from urllib.parse import urlsplit

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

_OP_CONTINUATION = 0x0
_OP_TEXT = 0x1
_OP_BINARY = 0x2
_OP_CLOSE = 0x8
_OP_PING = 0x9
_OP_PONG = 0xA

_MAX_MESSAGE = 16 * 1024 * 1024
_MAX_HANDSHAKE = 64 * 1024


class WebSocketError(Exception):
    """Base class for transport-level failures."""


class HandshakeError(WebSocketError):
    """The HTTP upgrade to WebSocket was refused or malformed."""


class ConnectionClosed(WebSocketError):
    """The peer closed the connection, or the transport died underneath us."""

    def __init__(self, code: int, reason: str = "") -> None:
        detail = f": {reason}" if reason else ""
        super().__init__(f"WebSocket closed with code {code}{detail}")
        self.code = code
        self.reason = reason


class RawWebSocket:
    """A blocking WebSocket client.

    Reads use a short socket timeout that is retried internally, so ``receive_text`` blocks
    without holding a thread hostage and a reader thread can notice a local ``close()``
    promptly instead of waiting out a long timeout.
    """

    def __init__(
        self,
        url: str,
        connect_timeout: float = 10.0,
        read_poll: float = 0.25,
    ) -> None:
        parts = urlsplit(url)
        if parts.scheme not in ("ws", "wss"):
            raise ValueError(
                f"Unsupported WebSocket scheme {parts.scheme!r}; expected ws:// or wss://"
            )
        if not parts.hostname:
            raise ValueError(f"WebSocket URL {url!r} has no host")

        self.url = url
        self.secure = parts.scheme == "wss"
        self._host = parts.hostname
        self._port = parts.port or (443 if self.secure else 80)
        self._path = parts.path or "/"
        if parts.query:
            self._path += "?" + parts.query

        self._connect_timeout = connect_timeout
        self._read_poll = read_poll
        self._sock: Optional[socket.socket] = None
        self._lock = threading.RLock()
        self._closed = False
        self._close_code = 1006
        self._close_reason = ""

    # -- lifecycle ----------------------------------------------------

    def connect(self) -> None:
        """Perform the HTTP upgrade. Raises :class:`HandshakeError` on failure."""
        if self._sock is not None:
            return

        try:
            sock = socket.create_connection(
                (self._host, self._port), timeout=self._connect_timeout
            )
        except OSError as exc:
            raise HandshakeError(f"Could not reach AuraUI at {self.url}: {exc}") from exc

        if self.secure:
            try:
                context = ssl.create_default_context()
                sock = context.wrap_socket(sock, server_hostname=self._host)
            except OSError as exc:
                sock.close()
                raise HandshakeError(f"TLS handshake with {self._host} failed: {exc}") from exc

        sock.settimeout(self._read_poll)
        self._sock = sock

        key = base64.b64encode(os.urandom(16)).decode("ascii")
        default_port = 443 if self.secure else 80
        host_header = self._host if self._port == default_port else f"{self._host}:{self._port}"
        request = (
            f"GET {self._path} HTTP/1.1\r\n"
            f"Host: {host_header}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )

        try:
            sock.sendall(request.encode("ascii"))
            blob = self._read_until(b"\r\n\r\n", _MAX_HANDSHAKE)
        except WebSocketError:
            self._abort()
            raise

        head = blob.split(b"\r\n\r\n", 1)[0].decode("latin-1")
        lines = head.split("\r\n")
        status = lines[0] if lines else ""

        headers = {}
        for line in lines[1:]:
            name, _, value = line.partition(":")
            headers[name.strip().lower()] = value.strip()

        if " 101" not in status:
            self._abort()
            raise HandshakeError(f"AuraUI refused the WebSocket upgrade: {status or 'empty response'}")

        expected = base64.b64encode(
            hashlib.sha1((key + _WS_GUID).encode("ascii")).digest()
        ).decode("ascii")
        got = headers.get("sec-websocket-accept", "")
        if got != expected:
            self._abort()
            raise HandshakeError(
                "AuraUI's WebSocket handshake was not valid: Sec-WebSocket-Accept did not match. "
                "Something other than AuraUI may be listening on this port."
            )

    def close(self, code: int = 1000, reason: str = "") -> None:
        """Send a close frame and drop the socket. Safe to call twice."""
        with self._lock:
            sock = self._sock
            if sock is None:
                self._closed = True
                return
            payload = struct.pack("!H", code) + reason.encode("utf-8")[:123]
            try:
                self._send_frame(_OP_CLOSE, payload)
            except WebSocketError:
                pass
            self._closed = True
            self._close_code = code
            self._close_reason = reason
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass
            self._sock = None

    def _abort(self) -> None:
        sock, self._sock = self._sock, None
        self._closed = True
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass

    @property
    def closed(self) -> bool:
        return self._closed

    # -- reading ------------------------------------------------------

    def receive_text(self) -> str:
        """Block until one complete text message arrives.

        Control frames (ping, pong, close) are handled here so callers never see them.
        """
        fragments = bytearray()
        while True:
            fin, opcode, payload = self._read_frame()

            if opcode == _OP_PING:
                with self._lock:
                    self._send_control(_OP_PONG, payload)
                continue

            if opcode == _OP_PONG:
                continue

            if opcode == _OP_CLOSE:
                code, reason = 1005, ""
                if len(payload) >= 2:
                    code = struct.unpack("!H", payload[:2])[0]
                    reason = payload[2:].decode("utf-8", "replace")
                with self._lock:
                    self._send_control(_OP_CLOSE, struct.pack("!H", 1000))
                self._closed = True
                self._close_code = code
                self._close_reason = reason
                raise ConnectionClosed(code, reason)

            if opcode in (_OP_TEXT, _OP_CONTINUATION):
                fragments.extend(payload)
                if len(fragments) > _MAX_MESSAGE:
                    raise WebSocketError("AuraUI message exceeds the 16 MiB limit")
                if fin:
                    try:
                        return fragments.decode("utf-8")
                    except UnicodeDecodeError as exc:
                        raise WebSocketError(f"AuraUI sent invalid UTF-8: {exc}") from exc
                continue

            if opcode == _OP_BINARY:
                raise WebSocketError("AuraUI does not use binary frames (received opcode 0x2)")

            raise WebSocketError(f"Unsupported WebSocket opcode 0x{opcode:x}")

    def _read_frame(self):
        header = self._read_exact(2)
        fin = bool(header[0] & 0x80)
        opcode = header[0] & 0x0F
        masked = bool(header[1] & 0x80)
        length = header[1] & 0x7F

        if length == 126:
            length = struct.unpack("!H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._read_exact(8))[0]

        if length > _MAX_MESSAGE:
            raise WebSocketError(f"Frame of {length} bytes exceeds the 16 MiB limit")

        # A server must not mask, but tolerate one that does rather than mis-decoding.
        mask = self._read_exact(4) if masked else None
        payload = self._read_exact(length) if length else b""
        if mask is not None:
            payload = bytes(byte ^ mask[index & 3] for index, byte in enumerate(payload))
        return fin, opcode, payload

    def _read_exact(self, count: int) -> bytes:
        buf = bytearray()
        while len(buf) < count:
            chunk = self._recv(count - len(buf))
            if not chunk:
                # A close() on this side shuts the socket down while the reader is parked in
                # recv(), and an empty read then looks identical to a peer hang-up. Report
                # what the caller asked for rather than an alarming 1006.
                if self._closed:
                    raise ConnectionClosed(self._close_code, self._close_reason)
                self._closed = True
                self._close_code = 1006
                self._close_reason = "connection closed by peer"
                raise ConnectionClosed(1006, "connection closed by peer")
            buf.extend(chunk)
        return bytes(buf)

    def _read_until(self, marker: bytes, limit: int) -> bytes:
        buf = bytearray()
        while marker not in buf:
            if len(buf) > limit:
                raise HandshakeError("Handshake response exceeded 64 KiB")
            chunk = self._recv(4096)
            if not chunk:
                raise HandshakeError("Connection closed during the WebSocket handshake")
            buf.extend(chunk)
        return bytes(buf)

    def _recv(self, count: int) -> bytes:
        while True:
            if self._closed:
                raise ConnectionClosed(self._close_code, self._close_reason)
            sock = self._sock
            if sock is None:
                raise ConnectionClosed(1006, "socket is not open")
            try:
                return sock.recv(count)
            except socket.timeout:
                # A poll interval elapsed with no data: loop so a local close() is noticed.
                continue
            except (OSError, ValueError) as exc:
                # Same reasoning as in _read_exact: once this side has closed the socket, a
                # failing recv() is expected and not a transport error.
                if self._closed:
                    raise ConnectionClosed(self._close_code, self._close_reason) from exc
                self._closed = True
                self._close_code = 1006
                self._close_reason = f"transport error: {exc}"
                raise ConnectionClosed(1006, self._close_reason) from exc

    # -- writing ------------------------------------------------------

    def send_text(self, text: str) -> None:
        """Send one text message, masked as a client must."""
        data = text.encode("utf-8")
        if len(data) > _MAX_MESSAGE:
            raise WebSocketError("Refusing to send a message above the 16 MiB limit")
        with self._lock:
            self._send_frame(_OP_TEXT, data)

    def ping(self, payload: bytes = b"") -> None:
        """Send a ping. AuraUI answers with a pong, which readers discard."""
        with self._lock:
            self._send_frame(_OP_PING, payload)

    def _send_control(self, opcode: int, payload: bytes) -> None:
        try:
            self._send_frame(opcode, payload)
        except WebSocketError:
            # A control frame on a dying socket is not worth surfacing.
            pass

    def _send_frame(self, opcode: int, payload: bytes = b"") -> None:
        sock = self._sock
        if sock is None or self._closed:
            raise ConnectionClosed(1006, "socket is not open")

        length = len(payload)
        header = bytearray()
        header.append(0x80 | opcode)  # FIN set: this client never fragments what it sends.
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))

        mask = os.urandom(4)
        header.extend(mask)
        masked = bytearray(payload)
        for index in range(length):
            masked[index] ^= mask[index & 3]

        try:
            sock.sendall(bytes(header) + bytes(masked))
        except OSError as exc:
            self._closed = True
            self._close_code = 1006
            self._close_reason = f"transport error while sending: {exc}"
            raise ConnectionClosed(1006, self._close_reason) from exc
