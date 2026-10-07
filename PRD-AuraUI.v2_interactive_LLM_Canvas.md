

# AuraUI: Generative UI & Interactive Canvas Agent Bridge
**Master Development Document v2.0**

## 1. Product Overview
AuraUI is a local-first desktop and mobile client framework designed to act as a **Human-in-the-Loop (HITL) Task Engine**. It bridges the gap between external AI Agents (running via Python, LangChain, IDE extensions, etc.) and dynamic, interactive user interfaces. 

Instead of an Agent relying solely on text or static screenshots, AuraUI allows the Agent to dynamically summon structured UI components (tables, interactive charts, routing wizards) or control a native Webview to ask the user for visual validation, DOM-level interactions, or markup feedback.

### Core Objectives
*   **Zero-Hallucination UI & Data:** Enforce strict JSON payloads. The LLM never writes raw frontend code, and for charts, it only writes the query/schema—the Agent provides the ground-truth data.
*   **The "Oracle" User Experience:** Allow the Agent to treat the user as an "Oracle" to perform tasks it cannot (e.g., "Sort these items," "Draw a box around the broken UI element," "Log into this website").
*   **Ultra-Low Latency Bridge:** Utilize a local WebSocket server to stream UI schemas to the frontend and user telemetry back to the Agent instantly.

---

## 2. System Architecture

AuraUI operates on a tri-node architecture:

```text
┌────────────────────────────────────────────────────────┐
│                   External AI Agent                    │
│   (Python/Node Script, LangChain, IDE, API backend)    │
└───────────────────────────┬────────────────────────────┘
                            │ WebSocket (ws://127.0.0.1:9090)
                            │ Bidirectional JSON
                            ▼
┌────────────────────────────────────────────────────────┐
│               AuraUI Tauri v2 App Core                 │
│  ┌──────────────────────┐    ┌──────────────────────┐  │
│  │    Rust Backend      │◄──►│ Webview Frontend     │  │
│  │ (tokio-tungstenite   │IPC │ (React + Tailwind +  │  │
│  │  WebSocket Server)   │    │  shadcn/ui Engine)   │  │
│  └──────────────────────┘    └──────────┬───────────┘  │
└─────────────────────────────────────────┼──────────────┘
                                          │ User Interaction
                                          ▼
                         ┌────────────────────────────────┐
                         │   Dynamic Component Renderer   │
                         │ (Vega-Lite, tldraw, DOM Logger)│
                         └────────────────────────────────┘
```

### Technology Stack
*   **Core Framework:** Tauri v2 (Cross-platform desktop/mobile wrapper).
*   **Backend/Bridge:** Rust with `tokio-tungstenite` for the Agent WebSocket server.
*   **Frontend Engine:** React.js + Tailwind CSS.
*   **UI Components:** shadcn/ui (lean, headless, utility-first).
*   **Visual Markup Canvas:** `tldraw` (Optimized for React, outputs strict vector JSON).
*   **Interactive Charts:** `react-vega` (Vega-Lite grammar of graphics to prevent data hallucination).

---

## 3. Core Capabilities & Implementation Mechanisms

### 1. Branching Question Trees (WizardForms & ActionCards)
*   **Mechanism:** Agent sends a structured JSON array of buttons/options. React renders them via `shadcn`. 
*   **Interaction:** Clicking an option instantly destroys the UI view and transmits the `action_id` back down the WebSocket to the Agent to determine the next branch.

### 2. Interactive Data Tables (DataGrids)
*   **Mechanism:** Agent sends column definitions and row data.
*   **Interaction:** User can sort or explicitly select a row (e.g., "Select the anomaly record"). Row ID is transmitted back to the Agent.

### 3. Interactive Exploratory Charts (The "Power BI" Loop)
*   **Mechanism:** To prevent the LLM from hallucinating math, we use **Vega-Lite**. The LLM writes a SQL query and a visual schema. The Agent runs the query against the real database, bundles the raw data with the schema, and sends it to AuraUI.
*   **Interaction:** When a user clicks a bar on a chart (e.g., "North America"), Vega-Lite captures the selection. AuraUI intercepts this and fires a `chart_filter` event to the Agent. The Agent updates its query, fetching drill-down data, and updates the UI.

### 4. Live Webview Telemetry Logging
*   **Mechanism:** Agent commands AuraUI to open a URL in `recording_mode`.
*   **Interaction:** Tauri injects a lightweight `preload.js` script into the target website's DOM before it loads. As the user clicks and types, the script captures `element ID`, `XPath`, `text value`, and `coordinates`, streaming them via Tauri IPC -> Rust -> WebSocket -> Agent.

### 5. Webview Snapshot & Canvas Markup (Redlining)
*   **Mechanism (Solving the "Glass Pane" Problem):** When the Agent needs visual direction, or the user clicks "Mark Up", AuraUI triggers a native window capture, generating a base64 PNG of the current Webview.
*   **Interaction:** The live Webview is hidden, and `tldraw` is instantly mounted with the PNG as its background. The user draws bounding boxes or writes text.
*   **Payload:** On submit, AuraUI extracts the coordinates, grabs the raw HTML snippet *underneath* those coordinates from the hidden Webview using `document.elementFromPoint`, and sends a multi-modal payload (Base64 Image + Vector JSON + HTML Snippet) back to the Agent.

---

## 4. Agent Schema (JSON Contracts)

The Agent communicates with AuraUI strictly via JSON. Below are examples of task payloads.

**Task: Sortable List**
```json
{
  "taskId": "task_101",
  "component": "SortableList",
  "instruction": "Please arrange these steps in the correct order for the deployment pipeline.",
  "props": {
    "items": ["Build Docker Image", "Run Unit Tests", "Deploy to Staging"]
  }
}
```

**Task: Interactive Chart (Vega-Lite)**
```json
{
  "taskId": "task_102",
  "component": "InteractiveChart",
  "instruction": "Click on a region to drill down into state-level metrics.",
  "props": {
    "vegaSchema": { "$schema": "https://vega.github.io/schema/vega-lite/v5.json", "mark": "bar", "encoding": {"x": {"field": "region"}, "y": {"field": "sales"}} },
    "data": [ {"region": "North America", "sales": 15000}, {"region": "EMEA", "sales": 8000} ]
  }
}
```

**Task: Webview Markup Request**
```json
{
  "taskId": "task_103",
  "component": "LiveWebTask",
  "instruction": "Please draw a box around the UI element that is rendering incorrectly.",
  "props": {
    "url": "https://staging.internal-app.com/dashboard",
    "mode": "redline_request"
  }
}
```

---

## 5. Development Roadmap

### Milestone 1: The Core Bridge & UI Engine (Desktop MVP)
*   Initialize Tauri v2 Rust environment and React + Tailwind frontend.
*   Implement `tokio-tungstenite` WebSocket server on port `9090`.
*   Build the core Generative UI JSON parser.
*   Implement `ActionCard`, `SortableList`, and `DataGrid`.
*   *Outcome:* An agent can connect, send JSON, and receive button clicks/form submissions.

### Milestone 2: Advanced Visuals & Data (Vega-Lite & Canvas)
*   Integrate `react-vega` for interactive, non-hallucinated data visualizations.
*   Integrate `tldraw` component.
*   *Outcome:* Agent can render complex PowerBI-style charts and receive drill-down click events.

### Milestone 3: The Webview Task Loop
*   Implement Tauri Webview window management.
*   Write `preload.js` for DOM interaction logging (XPath extraction).
*   Implement the "Snapshot & Swap" architecture for webview redlining.
*   *Outcome:* Agent can command a web browser, record user workflows, and ask for visual DOM markup.

### Milestone 4: Mobile Parity & Polish
*   Compile Tauri v2 targets for Android.
*   Optimize UI layouts for touch (React/shadcn).
*   Implement local network discovery for mobile devices to connect to desktop agents.