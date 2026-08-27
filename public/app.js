const root = document.querySelector("#app");
let identity = JSON.parse(localStorage.getItem("identity") || "null");
let active = null;
let lobbyTimer = null;
let currentScreen = null;
const gates = ["INPUT", "OUTPUT", "AND", "OR", "NOT", "XOR", "NOR", "NAND"];
const post = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw Error(data.error || "Request failed");
  return data;
};
function header() {
  return `<header class="topbar"><div class="brand"><i></i>current</div>${identity ? `<div class="presence"><span class="dot"></span>${identity.assignedName}</div>` : ""}</header>`;
}
function landing() {
  root.innerHTML =
    header() +
    `<section class="wrap"><div class="hero">
    <div class="kicker">Remote logic rooms</div>
    <h1>Think in circuits.<br>Build together.</h1>
    <p>A quiet workspace for two people to sketch, connect, and test logic in real time.</p>
    <form class="form"><input class="input" name="name" placeholder="Your name" maxlength="28" autofocus>
    <button class="primary">Enter workspace</button></form></div></section>`;
  root.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    identity = await post("/api/identity", { name });
    localStorage.setItem("identity", JSON.stringify(identity));
    lobby();
  };
}
async function lobby() {
  currentScreen = "lobby";
  clearTimeout(lobbyTimer);
  const rooms = await fetch("/api/circuits").then((r) => r.json());
  if (currentScreen !== "lobby") return;
  root.innerHTML =
    header() +
    `<section class="wrap"><div class="section-head"><div><div class="kicker">Workspace</div><h1>Choose a room</h1></div><button class="primary" id="new">New circuit</button></div><div class="rooms">${rooms.length ? rooms.map((r) => `<div class="room"><div><h3>${r.label}</h3><small>Grid ${r.gridSize}px · created ${new Date(r.createdAt).toLocaleDateString()}</small></div><span class="meta">${r.participants}/2 connected</span><button class="join" ${r.participants >= 2 ? "disabled" : ""} data-id="${r.id}">${r.participants >= 2 ? "Full" : "Join room"}</button></div>`).join("") : `<div class="empty">No rooms yet. Start a new circuit for your pair.</div>`}</div></section>`;
  root.querySelector("#new").onclick = () => newRoom();
  root
    .querySelectorAll(".join")
    .forEach((b) => (b.onclick = () => join(+b.dataset.id)));
  lobbyTimer = setTimeout(lobby, 5000);
}
function newRoom() {
  currentScreen = "new-room";
  clearTimeout(lobbyTimer);
  root.innerHTML =
    header() +
    `<section class="wrap"><div class="hero"><div class="kicker">New room</div><h1>Set the grid.</h1><p>Choose a comfortable spacing, then invite one other person by sharing the room URL.</p><form class="form"><input class="input" name="label" placeholder="Circuit name" value="Untitled circuit"><input class="input" name="gridSize" type="number" min="16" max="40" value="24"><button class="primary">Create room</button></form></div></section>`;
  root.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const d = await post("/api/circuits", {
      label: e.target.label.value,
      gridSize: e.target.gridSize.value,
    });
    await join(d.id);
  };
}
async function join(id) {
  try {
    const d = await post(`/api/circuits/${id}/join`, identity);
    openEditor(d.circuit);
  } catch (e) {
    alert(e.message);
  }
}
function evaluate(components, wires) {
  const values = {};
  let changed = true;
  components
    .filter((c) => c.type === "INPUT")
    .forEach((c) => (values[c.id] = !!c.state));
  while (changed) {
    changed = false;
    components
      .filter((c) => !["INPUT", "OUTPUT"].includes(c.type))
      .forEach((c) => {
        const ins = wires
          .filter((w) => w.to === c.id)
          .map((w) => values[w.from]);
        if (ins.some((v) => v === undefined)) return;
        const [a, b] = ins;
        let v =
          c.type === "NOT"
            ? !a
            : c.type === "AND"
              ? a && b
              : c.type === "OR"
                ? a || b
                : c.type === "XOR"
                  ? a !== b
                  : c.type === "NOR"
                    ? !(a || b)
                    : c.type === "NAND"
                      ? !(a && b)
                      : false;
        if (values[c.id] !== v) {
          values[c.id] = v;
          changed = true;
        }
      });
  }
  components
    .filter((c) => c.type === "OUTPUT")
    .forEach((c) => {
      const w = wires.find((w) => w.to === c.id);
      values[c.id] = w ? !!values[w.from] : false;
    });
  return values;
}
function openEditor(cs) {
  currentScreen = "editor";
  clearTimeout(lobbyTimer);
  active = cs;
  let selectedTool = null,
    wireMode = false,
    deleteMode = false,
    selected = null,
    values = evaluate(cs.components, cs.wires);
  root.innerHTML = `<div class="editor">${header()}<div class="editor-main"><aside class="palette"><button class="back" id="back-lobby">Back</button><h2>Components</h2><div class="tools">${gates.map((g) => `<button class="tool component-tool" data-tool="${g}"><b>${g}</b></button>`).join("")}<button class="tool tool-action" id="wire-tool"><b>Wire</b></button><button class="tool tool-action" id="delete-tool"><b>Delete</b></button></div><button class="simulate" id="print-now">Print Now</button><p class="note">Choose a component, then place it on the grid. Wire and Delete are single-use modes.</p><div id="notice" class="notice" role="status"></div></aside><div class="canvas-wrap"><canvas class="canvas" width="900" height="640"></canvas></div><aside class="inspector"><h2>${cs.label}</h2><p class="note">Live signal monitor <span id="presence-status">${cs.participants.length}/2</span></p><div id="readout"></div><p class="note">Room link<br><strong>${location.origin}/?room=${cs.id}</strong></p></aside></div></div>`;
  const canvas = root.querySelector("canvas"),
    ctx = canvas.getContext("2d");
  root.querySelectorAll(".component-tool").forEach(
    (b) =>
      (b.onclick = () => {
        selectedTool = b.dataset.tool;
        wireMode = false;
        deleteMode = false;
        selected = null;
        root
          .querySelectorAll(".tool")
          .forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
      }),
  );
  root.querySelector("#wire-tool").onclick = () => {
    wireMode = !wireMode;
    selectedTool = null;
    deleteMode = false;
    selected = null;
    root.querySelectorAll(".tool").forEach((b) => b.classList.remove("active"));
    if (wireMode) root.querySelector("#wire-tool").classList.add("active");
  };
  root.querySelector("#delete-tool").onclick = () => {
    deleteMode = !deleteMode;
    selectedTool = null;
    wireMode = false;
    selected = null;
    root.querySelectorAll(".tool").forEach((b) => b.classList.remove("active"));
    if (deleteMode) root.querySelector("#delete-tool").classList.add("active");
  };
  root.querySelector("#print-now").onclick = () => {
    values = evaluate(cs.components, cs.wires);
    draw();
    window.print();
  };
  let heartbeatTimer;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 3;
    cs.wires.forEach((w) => {
      const a = cs.components.find((c) => c.id == w.from),
        b = cs.components.find((c) => c.id == w.to);
      if (!a || !b) return;
      ctx.strokeStyle = values[a.id] ? "#e2a43b" : "#b8c1ba";
      ctx.beginPath();
      ctx.moveTo(a.x + 70, a.y + 22);
      ctx.lineTo(b.x, b.y + 22);
      ctx.stroke();
    });
    cs.components.forEach((c) => {
      const isOn = Boolean(values[c.id]);
      ctx.fillStyle =
        c.type === "OUTPUT" && isOn
          ? "#e2a43b"
          : c.type === "INPUT" && isOn
            ? "#d85d3e"
            : "#fff";
      ctx.strokeStyle =
        c.id === selected
          ? "#d85d3e"
          : c.type === "OUTPUT" && isOn
            ? "#b97918"
            : "#17211b";
      ctx.lineWidth = 2;
      ctx.fillRect(c.x, c.y, 70, 44);
      ctx.strokeRect(c.x, c.y, 70, 44);
      ctx.fillStyle =
        isOn && (c.type === "INPUT" || c.type === "OUTPUT")
          ? "#fff"
          : "#17211b";
      ctx.font = "600 11px DM Sans";
      ctx.fillText(c.label || c.type, c.x + 7, c.y + 16);
      if (c.type === "INPUT") {
        ctx.fillStyle = isOn ? "#fff" : "#f1f3ef";
        ctx.fillRect(c.x + 7, c.y + 23, 56, 15);
        ctx.fillStyle = isOn ? "#d85d3e" : "#17211b";
        ctx.fillText(isOn ? "1  ON" : "0  OFF", c.x + 18, c.y + 34);
      }
      if (c.type === "OUTPUT") {
        ctx.fillStyle = isOn ? "#17211b" : "#758078";
        ctx.fillText(isOn ? "LIT · 1" : "OFF · 0", c.x + 7, c.y + 34);
      }
    });
    document.querySelector("#readout").innerHTML =
      cs.components
        .filter((c) => c.type === "OUTPUT")
        .map(
          (c) =>
            `<div class="output-row"><span>${c.label || "OUTPUT"}</span><strong class="value ${values[c.id] ? "signal-on" : ""}">${values[c.id] ? "1" : "0"}</strong></div>`,
        )
        .join("") || '<p class="note">Place an output to read a signal.</p>';
  }
  function point(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - r.left) / 24) * 24,
      y: Math.round((e.clientY - r.top) / 24) * 24,
    };
  }
  canvas.onclick = async (e) => {
    const p = point(e),
      hit = cs.components.find(
        (c) => p.x >= c.x && p.x <= c.x + 70 && p.y >= c.y && p.y <= c.y + 44,
      );
    const wireHit =
      deleteMode && !hit &&
      cs.wires.find((w) => {
        const a = cs.components.find((c) => c.id === w.from);
        const b = cs.components.find((c) => c.id === w.to);
        if (!a || !b) return false;
        const dx = b.x - a.x + 70;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy) || 1;
        const distance = Math.abs(dy * (p.x - (a.x + 70)) - dx * (p.y - (a.y + 22))) / length;
        return distance <= 12;
      });
    if (hit) {
      if (deleteMode) {
        const removed = hit;
        cs.components = cs.components.filter((c) => c !== removed);
        cs.wires = cs.wires.filter((w) => w.from !== removed.id && w.to !== removed.id);
        await act({ type: "component_removed", id: removed.id });
        draw();
        return;
      }
      const inputButton =
        hit.type === "INPUT" &&
        p.x >= hit.x + 7 &&
        p.x <= hit.x + 63 &&
        p.y >= hit.y + 23 &&
        p.y <= hit.y + 38;
      if (inputButton && !wireMode && !selectedTool) {
        hit.state = !hit.state;
        values = evaluate(cs.components, cs.wires);
        draw();
        await act({ type: "input_toggled", id: hit.id, state: hit.state });
      } else if (wireMode) {
        if (!selected) selected = hit;
        else if (selected !== hit) {
          const sourceCount = cs.wires.filter((w) => w.from === selected.id).length;
          const destinationCount = cs.wires.filter((w) => w.to === hit.id).length;
          const destinationLimit = ["NOT", "OUTPUT"].includes(hit.type) ? 1 : 2;
          if (selected.type === "OUTPUT" || hit.type === "INPUT" || selected.id === hit.id) {
            root.querySelector("#notice").textContent = "That connection is not valid.";
            selected = null;
            draw();
            return;
          }
          if (destinationCount >= destinationLimit) {
            root.querySelector("#notice").textContent = "That input pin is already full.";
            selected = null;
            draw();
            return;
          }
          if (sourceCount >= 1) {
            root.querySelector("#notice").textContent = "That output pin is already connected.";
            selected = null;
            draw();
            return;
          }
          const wire = { id: Date.now(), from: selected.id, to: hit.id };
          cs.wires.push(wire);
          try {
            await act({ type: "wire_added", wire });
          } catch (error) {
            cs.wires = cs.wires.filter((w) => w.id !== wire.id);
            root.querySelector("#notice").textContent = error.message;
          }
          selected = null;
          wireMode = false;
          root.querySelector("#wire-tool").classList.remove("active");
        }
      } else selected = hit;
      draw();
      return;
    }
    if (wireHit) {
      cs.wires = cs.wires.filter((w) => w.id !== wireHit.id);
      await act({ type: "wire_removed", id: wireHit.id });
      draw();
      return;
    }
    if (selectedTool) {
      const component = {
        id: Date.now(),
        type: selectedTool,
        x: p.x,
        y: p.y,
        state: false,
      };
      cs.components.push(component);
      selectedTool = null;
      const result = await act({ type: "component_added", component });
      Object.assign(component, result.component || {});
      root
        .querySelectorAll(".component-tool")
        .forEach((x) => x.classList.remove("active"));
      draw();
    }
  };
  canvas.oncontextmenu = (e) => e.preventDefault();
  async function act(payload) {
    const result = await post(`/api/circuits/${cs.id}/action`, payload);
    values = evaluate(cs.components, cs.wires);
    draw();
    return result;
  }
  const source = new EventSource(`/api/circuits/${cs.id}/events`);
  const onPageHide = () => {
    clearInterval(heartbeatTimer);
    fetch(`/api/circuits/${cs.id}/leave`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: identity.sessionId }),
      keepalive: true,
    });
  };
  window.addEventListener("pagehide", onPageHide, { once: true });
  root.querySelector("#back-lobby").onclick = async () => {
    window.removeEventListener("pagehide", onPageHide);
    clearInterval(heartbeatTimer);
    await post(`/api/circuits/${cs.id}/leave`, { sessionId: identity.sessionId });
    source.close();
    lobby();
  };
  heartbeatTimer = setInterval(() => {
    post(`/api/circuits/${cs.id}/heartbeat`, { sessionId: identity.sessionId }).catch(() => {});
  }, 10000);
  source.onmessage = (e) => {
    const p = JSON.parse(e.data);
    if (
      p.type === "component_added" &&
      !cs.components.some((c) => c.id === p.component.id)
    )
      cs.components.push(p.component);
    if (p.type === "wire_added" && !cs.wires.some((w) => w.id === p.wire.id))
      cs.wires.push(p.wire);
    if (p.type === "input_toggled") {
      const c = cs.components.find((c) => c.id === p.id);
      if (c) c.state = p.state;
    }
    if (p.type === "component_removed") {
      cs.components = cs.components.filter((c) => c.id !== p.id);
      cs.wires = cs.wires.filter((w) => w.from !== p.id && w.to !== p.id);
    }
    if (p.type === "participant_left") {
      cs.participants = cs.participants.filter((participant) => participant.session !== p.sessionId);
      root.querySelector("#presence-status").textContent = `${cs.participants.length}/2`;
    }
    values = evaluate(cs.components, cs.wires);
    draw();
  };
  draw();
}
if (identity) lobby();
else landing();
