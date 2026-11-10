(function () {
  if (window.CC && window.CC.__v2Initialized) return;

  const FILES = "abcdefgh";
  const registeredScripts = new Map();
  const dynamicallyLoadedFiles = new Set();
  let hudShadow = null;

  // Перехватываем закрытый ShadowRoot главного меню ChessCoach
  const origAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const sr = origAttachShadow.call(this, init);
    if (
      this.id !== "cc-userscripts-host" &&
      this.id !== "cc-floating-orb-host" &&
      (!hudShadow || (init && init.mode === "closed"))
    ) {
      hudShadow = sr;
    }
    return sr;
  };

  let prevMatrix = null;
  let trackedState = {
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    boardMatrix: Array.from({ length: 8 }, () => Array(8).fill(null)),
    isBlackOrientation: false,
    myColor: "w",
    lastMoveFrom: null,
    lastMoveTo: null,
    isCapture: false,
    capturedPiece: null,
    isCheck: false,
    kingSquare: null,
    bestMoveUci: "",
    bestMoveFrom: null,
    bestMoveTo: null,
    bestEvalText: "0.00",
    avgMoveUci: "",
    myClock: "--:--",
    enemyClock: "--:--",
    moveCount: 0,
    openingName: ""
  };

  let lastEvalSig = "";
  let lastMovePairSig = "";

  let scriptsHost = null;
  let scriptsShadow = null;

  const DOCKED_SCRIPT_STYLES = `
    .cc-docked-script-win {
      margin-top: 10px;
      background: rgba(8, 11, 19, 0.92);
      border: 1px solid rgba(0, 245, 212, 0.35);
      border-radius: 14px;
      overflow: hidden;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 8px 24px rgba(0, 0, 0, 0.45);
    }
    .cc-script-win-bar {
      height: 3px;
      width: 100%;
      background: linear-gradient(90deg, #00f5d4, #00bbf9, #c77dff, #ff2a85);
    }
    .cc-script-win-header {
      padding: 9px 12px;
      background: rgba(5, 7, 13, 0.9);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      font-weight: 900;
      color: #00f5d4;
      letter-spacing: 0.4px;
    }
    .cc-script-win-body {
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 9px;
    }
    .cc-ctrl-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 9px 11px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.10);
      border-radius: 11px;
      font-size: 11.5px;
      font-weight: 700;
      color: #f1f5f9;
    }
    .cc-ctrl-col {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 9px 11px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.10);
      border-radius: 11px;
      font-size: 11px;
      color: #f1f5f9;
    }
    .cc-tabs-bar {
      display: grid;
      gap: 6px;
      background: rgba(5, 7, 13, 0.8);
      padding: 5px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.09);
    }
    .cc-tab-trigger {
      background: transparent;
      border: 1px solid transparent;
      color: #94a3b8;
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 11px;
      font-weight: 800;
      cursor: pointer;
    }
    .cc-tab-trigger.active {
      background: rgba(0, 245, 212, 0.18);
      color: #fff;
      border-color: #00f5d4;
    }
  `;

  // Контейнер для 60 FPS Canvas на доске и всплывающих OSD-баннеров
  function getScriptsShadow() {
    if (scriptsShadow) return scriptsShadow;
    scriptsHost = document.createElement("div");
    scriptsHost.id = "cc-userscripts-host";
    scriptsHost.style.cssText =
      "all:initial; position:fixed; top:0; left:0; width:0; height:0; z-index:2147483644; pointer-events:none;";
    document.documentElement.appendChild(scriptsHost);
    scriptsShadow = origAttachShadow.call(scriptsHost, { mode: "open" });

    const baseStyle = document.createElement("style");
    baseStyle.textContent = DOCKED_SCRIPT_STYLES;
    scriptsShadow.appendChild(baseStyle);
    return scriptsShadow;
  }

  async function loadScriptFileFromFolder(fileName, saveToList = true) {
    const cleanName = String(fileName || "").trim().replace(/^.*[\\/]/, "");
    if (!cleanName || !cleanName.endsWith(".js") || cleanName === "sample.js") return false;
    if (dynamicallyLoadedFiles.has(cleanName)) return true;

    try {
      const fileUrl = chrome.runtime.getURL("scripts/" + cleanName);
      await import(fileUrl + "?t=" + Date.now());
      dynamicallyLoadedFiles.add(cleanName);

      if (saveToList && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["cc_custom_script_files"], (res) => {
          const list = Array.isArray(res?.cc_custom_script_files) ? res.cc_custom_script_files : [];
          if (!list.includes(cleanName)) {
            list.push(cleanName);
            chrome.storage.local.set({ cc_custom_script_files: list });
          }
        });
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  function autoLoadSavedScriptFiles() {
    try {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["cc_custom_script_files"], (res) => {
          const list = Array.isArray(res?.cc_custom_script_files) ? res.cc_custom_script_files : [];
          list.forEach((fName) => loadScriptFileFromFolder(fName, false));
        });
      }
    } catch (e) {}
  }

  let boardOverlayWrap = null;
  let boardSvgRoot = null;
  let boardCanvasEl = null;
  let boardCanvasCtx = null;

  function ensureBoardOverlayElements() {
    const root = getScriptsShadow();
    if (!boardOverlayWrap) {
      boardOverlayWrap = document.createElement("div");
      boardOverlayWrap.id = "cc-scripts-board-overlay";
      boardOverlayWrap.style.cssText =
        "position:fixed; pointer-events:none; z-index:2147483644; display:none;";

      boardSvgRoot = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      boardSvgRoot.setAttribute("viewBox", "0 0 800 800");
      boardSvgRoot.style.cssText = "position:absolute; inset:0; width:100%; height:100%; pointer-events:none;";

      boardCanvasEl = document.createElement("canvas");
      boardCanvasEl.width = 800;
      boardCanvasEl.height = 800;
      boardCanvasEl.style.cssText = "position:absolute; inset:0; width:100%; height:100%; pointer-events:none;";
      boardCanvasCtx = boardCanvasEl.getContext("2d");

      boardOverlayWrap.appendChild(boardSvgRoot);
      boardOverlayWrap.appendChild(boardCanvasEl);
      root.appendChild(boardOverlayWrap);
    }

    const rect = getBoardRect();
    if (!rect || rect.width < 50) {
      boardOverlayWrap.style.display = "none";
      return null;
    }

    boardOverlayWrap.style.display = "block";
    boardOverlayWrap.style.left = rect.left + "px";
    boardOverlayWrap.style.top = rect.top + "px";
    boardOverlayWrap.style.width = rect.width + "px";
    boardOverlayWrap.style.height = rect.height + "px";
    return rect;
  }

  function getBoardElement() {
    const candidates = document.querySelectorAll(
      ".main-board cg-board, cg-board, wc-chess-board, chess-board, #board-single, #board-play-computer, .board"
    );
    let best = null;
    let maxArea = 0;
    for (const node of candidates) {
      const r = node.getBoundingClientRect();
      if (r.width >= 180 && r.height >= 180 && r.width * r.height > maxArea) {
        maxArea = r.width * r.height;
        best = node;
      }
    }
    return best;
  }

  function getBoardRect() {
    const b = getBoardElement();
    return b ? b.getBoundingClientRect() : null;
  }

  function sqToXY(sq) {
    if (!sq || typeof sq !== "string" || sq.length < 2) return { x: 400, y: 400 };
    const file = FILES.indexOf(sq[0].toLowerCase());
    const rank = parseInt(sq[1], 10) - 1;
    if (file < 0 || file > 7 || isNaN(rank) || rank < 0 || rank > 7) return { x: 400, y: 400 };
    const isBlack = trackedState.isBlackOrientation;
    const col = isBlack ? 7 - file : file;
    const row = isBlack ? rank : 7 - rank;
    return { x: col * 100 + 50, y: row * 100 + 50 };
  }

  function scanBoardAndHudState() {
    const boardEl = getBoardElement();
    if (!boardEl) return;
    const rect = boardEl.getBoundingClientRect();
    if (rect.width < 50) return;

    const isChessCom = location.hostname.includes("chess.com");
    let isBlack = false;
    const matrix = Array.from({ length: 8 }, () => Array(8).fill(null));

    if (isChessCom) {
      isBlack = boardEl.classList.contains("flipped");
      boardEl.querySelectorAll(".piece").forEach((p) => {
        const cls = p.className || "";
        const tm = cls.match(/\b([wb])([pnbrqk])\b/i);
        const sm = cls.match(/\bsquare-(\d)(\d)\b/);
        if (tm && sm) {
          const col = parseInt(sm[1], 10) - 1;
          const row = 8 - parseInt(sm[2], 10);
          if (row >= 0 && row <= 7 && col >= 0 && col <= 7) {
            matrix[row][col] = tm[1].toLowerCase() === "w" ? tm[2].toUpperCase() : tm[2].toLowerCase();
          }
        }
      });
    } else {
      const wrap = boardEl.closest(".cg-wrap");
      isBlack = Boolean(wrap && wrap.classList.contains("orientation-black"));
      const cellW = rect.width / 8;
      const cellH = rect.height / 8;
      const pMap = { pawn: "p", knight: "n", bishop: "b", rook: "r", queen: "q", king: "k" };

      boardEl.querySelectorAll("piece").forEach((p) => {
        if (p.classList.contains("ghost") || p.classList.contains("fading")) return;
        const pr = p.getBoundingClientRect();
        if (pr.width === 0) return;
        const vCol = Math.floor((pr.left + pr.width / 2 - rect.left) / cellW);
        const vRow = Math.floor((pr.top + pr.height / 2 - rect.top) / cellH);
        if (vCol < 0 || vCol > 7 || vRow < 0 || vRow > 7) return;
        const row = isBlack ? 7 - vRow : vRow;
        const col = isBlack ? 7 - vCol : vCol;
        let sym = "p";
        for (const [k, v] of Object.entries(pMap)) {
          if (p.classList.contains(k)) { sym = v; break; }
        }
        matrix[row][col] = p.classList.contains("white") ? sym.toUpperCase() : sym;
      });
    }

    trackedState.isBlackOrientation = isBlack;
    trackedState.myColor = isBlack ? "b" : "w";

    if (prevMatrix) {
      let diff = 0;
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          if (prevMatrix[r][c] !== matrix[r][c]) diff++;
        }
      }
      if (diff > 0 && diff <= 4) {
        for (const col of ["w", "b"]) {
          const isCol = (ch) => ch && (col === "w" ? ch === ch.toUpperCase() : ch === ch.toLowerCase());
          let fromSq = null;
          let toSq = null;
          let capPiece = null;

          for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
              const oldP = prevMatrix[r][c];
              const newP = matrix[r][c];
              if (isCol(oldP) && !isCol(newP)) {
                if (!fromSq || oldP.toLowerCase() === "k") fromSq = FILES[c] + (8 - r);
              }
              if (isCol(newP) && !isCol(oldP)) {
                if (!toSq || newP.toLowerCase() === "k") {
                  toSq = FILES[c] + (8 - r);
                  if (oldP && !isCol(oldP)) capPiece = oldP.toLowerCase();
                }
              }
            }
          }

          if (fromSq && toSq) {
            trackedState.lastMoveFrom = fromSq;
            trackedState.lastMoveTo = toSq;
            trackedState.isCapture = Boolean(capPiece);
            trackedState.capturedPiece = capPiece;
            trackedState.moveCount++;
            break;
          }
        }
        prevMatrix = matrix.map((r) => r.slice());
      } else if (diff > 4) {
        prevMatrix = matrix.map((r) => r.slice());
        trackedState.moveCount = 0;
        trackedState.lastMoveFrom = null;
        trackedState.lastMoveTo = null;
        trackedState.isCapture = false;
        trackedState.capturedPiece = null;
      }
    } else {
      prevMatrix = matrix.map((r) => r.slice());
    }

    trackedState.boardMatrix = matrix;
    const fenRows = matrix.map((r) => {
      let s = "", empty = 0;
      for (const c of r) {
        if (!c) empty++;
        else { if (empty > 0) { s += empty; empty = 0; } s += c; }
      }
      if (empty > 0) s += empty;
      return s;
    });
    trackedState.fen = fenRows.join("/") + " " + trackedState.myColor + " KQkq - 0 1";

    const checkSqEl = document.querySelector("cg-board square.check");
    if (checkSqEl) {
      const cr = checkSqEl.getBoundingClientRect();
      const vCol = Math.floor((cr.left + cr.width / 2 - rect.left) / (rect.width / 8));
      const vRow = Math.floor((cr.top + cr.height / 2 - rect.top) / (rect.height / 8));
      const r = isBlack ? 7 - vRow : vRow;
      const c = isBlack ? 7 - vCol : vCol;
      trackedState.isCheck = true;
      trackedState.kingSquare = FILES[c] + (8 - r);
    } else {
      trackedState.isCheck = false;
      trackedState.kingSquare = null;
    }

    if (hudShadow) {
      const bestDesc = hudShadow.getElementById("cc-best-desc")?.textContent || "";
      const bestEval = hudShadow.getElementById("cc-best-eval")?.textContent || "0.00";
      const avgDesc = hudShadow.getElementById("cc-avg-desc")?.textContent || "";
      const opName = hudShadow.getElementById("cc-opening-name")?.textContent || "";
      const clocksVal = hudShadow.getElementById("cc-tele-clocks-val")?.textContent || "";

      const bm = bestDesc.match(/\b([a-h][1-8])\s*→\s*([a-h][1-8])/i);
      if (bm) {
        trackedState.bestMoveFrom = bm[1].toLowerCase();
        trackedState.bestMoveTo = bm[2].toLowerCase();
        trackedState.bestMoveUci = trackedState.bestMoveFrom + trackedState.bestMoveTo;
      }
      const am = avgDesc.match(/\b([a-h][1-8])\s*→\s*([a-h][1-8])/i);
      if (am) {
        trackedState.avgMoveUci = am[1].toLowerCase() + am[2].toLowerCase();
      }
      trackedState.bestEvalText = bestEval.trim();
      trackedState.openingName = opName.trim();

      const cm = clocksVal.match(/(\d+:\d+(?:\.\d+)?)\s*vs\s*(\d+:\d+(?:\.\d+)?)/);
      if (cm) {
        trackedState.myClock = cm[1];
        trackedState.enemyClock = cm[2];
      }
    }
  }

  function attachUiHelpersToContainer(bodyEl, scriptEntry) {
    const helpers = {
      addToggle(labelOrOpts, defaultVal, onChange) {
        const opts = typeof labelOrOpts === "object"
          ? labelOrOpts
          : { label: labelOrOpts, value: defaultVal, onChange };

        const row = document.createElement("label");
        row.className = "cc-ctrl-row";
        row.style.cursor = "pointer";

        const span = document.createElement("span");
        span.textContent = opts.label || "Тумблер";

        const chk = document.createElement("input");
        chk.type = "checkbox";
        chk.checked = Boolean(opts.value ?? opts.defaultValue);
        chk.style.cssText = "width:18px; height:18px; accent-color:#00f5d4; cursor:pointer;";

        chk.addEventListener("change", () => {
          if (typeof opts.onChange === "function") opts.onChange(chk.checked);
        });

        row.appendChild(span);
        row.appendChild(chk);
        bodyEl.appendChild(row);
        return chk;
      },

      addSlider(labelOrOpts, min, max, step, defaultVal, onChange) {
        const opts = typeof labelOrOpts === "object"
          ? labelOrOpts
          : { label: labelOrOpts, min, max, step, value: defaultVal, onChange };

        const wrap = document.createElement("div");
        wrap.className = "cc-ctrl-col";

        const top = document.createElement("div");
        top.style.cssText = "display:flex; justify-content:space-between; font-weight:700;";
        const lbl = document.createElement("span");
        lbl.textContent = opts.label || "Ползунок";
        const valSpan = document.createElement("strong");
        valSpan.style.color = "#00f5d4";
        valSpan.textContent = (opts.value ?? opts.min ?? 0) + (opts.unit || "");

        top.appendChild(lbl);
        top.appendChild(valSpan);

        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = String(opts.min ?? 0);
        slider.max = String(opts.max ?? 100);
        slider.step = String(opts.step ?? 1);
        slider.value = String(opts.value ?? opts.min ?? 0);
        slider.style.cssText = "width:100%; accent-color:#00f5d4; cursor:pointer;";

        slider.addEventListener("input", () => {
          const v = Number(slider.value);
          valSpan.textContent = v + (opts.unit || "");
          if (typeof opts.onChange === "function") opts.onChange(v);
        });

        wrap.appendChild(top);
        wrap.appendChild(slider);
        bodyEl.appendChild(wrap);
        return slider;
      },

      addColorPicker(labelOrOpts, defaultVal, onChange) {
        const opts = typeof labelOrOpts === "object"
          ? labelOrOpts
          : { label: labelOrOpts, value: defaultVal, onChange };

        const row = document.createElement("div");
        row.className = "cc-ctrl-row";

        const span = document.createElement("span");
        span.textContent = opts.label || "Цвет";

        const inp = document.createElement("input");
        inp.type = "color";
        inp.value = opts.value || "#00f5d4";
        inp.style.cssText =
          "width:36px; height:26px; border:1px solid rgba(255,255,255,0.25); border-radius:6px; background:transparent; cursor:pointer; padding:0;";

        inp.addEventListener("input", () => {
          if (typeof opts.onChange === "function") opts.onChange(inp.value);
        });

        row.appendChild(span);
        row.appendChild(inp);
        bodyEl.appendChild(row);
        return inp;
      },

      addFilePicker(labelOrOpts, acceptStr, onChange) {
        const opts = typeof labelOrOpts === "object"
          ? labelOrOpts
          : { label: labelOrOpts, accept: acceptStr, onChange };

        const wrap = document.createElement("div");
        wrap.className = "cc-ctrl-row";

        const span = document.createElement("span");
        span.textContent = opts.label || "Файл / Текстура";

        const btn = document.createElement("button");
        btn.className = "cc-btn cc-btn-primary";
        btn.style.padding = "6px 12px";
        btn.style.fontSize = "11px";
        btn.textContent = "📂 Выбрать...";

        const fileInp = document.createElement("input");
        fileInp.type = "file";
        fileInp.accept = opts.accept || "image/*";
        fileInp.style.display = "none";

        btn.addEventListener("click", () => fileInp.click());
        fileInp.addEventListener("change", (e) => {
          const file = e.target.files && e.target.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            btn.textContent = "✅ " + file.name.slice(0, 12);
            if (typeof opts.onChange === "function") opts.onChange(String(reader.result || ""), file);
          };
          reader.readAsDataURL(file);
        });

        wrap.appendChild(span);
        wrap.appendChild(btn);
        wrap.appendChild(fileInp);
        bodyEl.appendChild(wrap);
        return fileInp;
      },

      addKeybind(labelOrOpts, defaultKey, onTrigger) {
        const opts = typeof labelOrOpts === "object"
          ? labelOrOpts
          : { label: labelOrOpts, defaultKey, onTrigger };

        let currentKey = opts.defaultKey || opts.key || "KeyX";

        const row = document.createElement("div");
        row.className = "cc-ctrl-row";

        const span = document.createElement("span");
        span.textContent = opts.label || "Быстрое действие";

        const triggerBtn = document.createElement("button");
        triggerBtn.style.cssText =
          "background:rgba(0,245,212,0.16); border:1px solid #00f5d4; color:#00f5d4; border-radius:8px; padding:5px 11px; font-size:11px; font-weight:900; cursor:pointer;";
        triggerBtn.textContent = "⚡ ВЫПОЛНИТЬ";

        triggerBtn.addEventListener("click", (e) => {
          if (typeof opts.onTrigger === "function") opts.onTrigger(e);
        });

        const keyHandler = (e) => {
          const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : "";
          if (tag === "INPUT" || tag === "TEXTAREA") return;
          if (e.code === currentKey || e.key === currentKey || ("Key" + (e.key || "").toUpperCase()) === currentKey) {
            if (typeof opts.onTrigger === "function") opts.onTrigger(e);
          }
        };

        window.addEventListener("keydown", keyHandler);
        if (scriptEntry) {
          scriptEntry.cleanupListeners.push({ target: window, type: "keydown", fn: keyHandler });
        }

        row.appendChild(span);
        row.appendChild(triggerBtn);
        bodyEl.appendChild(row);
        return triggerBtn;
      },

      addSelect(labelOrOpts, optionsArr, defaultVal, onChange) {
        const opts = typeof labelOrOpts === "object"
          ? labelOrOpts
          : { label: labelOrOpts, options: optionsArr, value: defaultVal, onChange };

        const wrap = document.createElement("div");
        wrap.className = "cc-ctrl-col";

        const lbl = document.createElement("span");
        lbl.style.fontWeight = "700";
        lbl.textContent = opts.label || "Выбор";

        const sel = document.createElement("select");
        sel.className = "cc-select";

        (opts.options || []).forEach((item) => {
          const op = document.createElement("option");
          if (typeof item === "object") {
            op.value = item.value;
            op.textContent = item.label;
          } else {
            op.value = item;
            op.textContent = item;
          }
          if (op.value === opts.value) op.selected = true;
          sel.appendChild(op);
        });

        sel.addEventListener("change", () => {
          if (typeof opts.onChange === "function") opts.onChange(sel.value);
        });

        wrap.appendChild(lbl);
        wrap.appendChild(sel);
        bodyEl.appendChild(wrap);
        return sel;
      },

      addInput(labelOrOpts, placeholderStr, defaultVal, onChange) {
        const opts = typeof labelOrOpts === "object"
          ? labelOrOpts
          : { label: labelOrOpts, placeholder: placeholderStr, value: defaultVal, onChange };

        const wrap = document.createElement("div");
        wrap.className = "cc-ctrl-col";

        const lbl = document.createElement("span");
        lbl.style.fontWeight = "700";
        lbl.textContent = opts.label || "Текст";

        const inp = document.createElement("input");
        inp.type = "text";
        inp.placeholder = opts.placeholder || "";
        inp.value = opts.value || "";
        inp.style.cssText =
          "width:100%; background:rgba(10,13,20,0.95); color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:8px; padding:7px 9px; font-size:11.5px; font-weight:700; outline:none;";

        inp.addEventListener("input", () => {
          if (typeof opts.onChange === "function") opts.onChange(inp.value);
        });

        wrap.appendChild(lbl);
        wrap.appendChild(inp);
        bodyEl.appendChild(wrap);
        return inp;
      },

      addButton(labelOrOpts, onClick) {
        const opts = typeof labelOrOpts === "object"
          ? labelOrOpts
          : { label: labelOrOpts, onClick };

        const btn = document.createElement("button");
        btn.className = "cc-btn cc-btn-primary";
        btn.textContent = opts.label || "Кнопка";
        btn.addEventListener("click", () => {
          if (typeof opts.onClick === "function") opts.onClick();
        });
        bodyEl.appendChild(btn);
        return btn;
      },

      addInfo(textOrOpts) {
        const text = typeof textOrOpts === "object" ? textOrOpts.text : textOrOpts;
        const info = document.createElement("div");
        info.style.cssText = "font-size:11px; color:#94a3b8; line-height:1.4; padding:2px 4px;";
        info.textContent = text || "";
        bodyEl.appendChild(info);
        return info;
      },

      addNote(textOrOpts) {
        return helpers.addInfo(textOrOpts);
      },

      createTabs(tabNames = []) {
        const bar = document.createElement("div");
        bar.className = "cc-tabs-bar";
        bar.style.gridTemplateColumns = `repeat(${Math.max(1, tabNames.length)}, 1fr)`;

        const panesMap = {};
        const triggers = [];

        const panesContainer = document.createElement("div");
        panesContainer.style.cssText = "display:flex; flex-direction:column; gap:8px;";

        tabNames.forEach((name, idx) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "cc-tab-trigger" + (idx === 0 ? " active" : "");
          btn.textContent = name;

          const pane = document.createElement("div");
          pane.style.cssText = (idx === 0 ? "display:flex;" : "display:none;") + " flex-direction:column; gap:8px;";
          attachUiHelpersToContainer(pane, scriptEntry);

          panesMap[name] = pane;
          panesMap[idx] = pane;
          triggers.push({ btn, pane });

          btn.addEventListener("click", () => {
            triggers.forEach((t) => {
              t.btn.classList.toggle("active", t.btn === btn);
              t.pane.style.display = t.pane === pane ? "flex" : "none";
            });
          });

          bar.appendChild(btn);
          panesContainer.appendChild(pane);
        });

        bodyEl.appendChild(bar);
        bodyEl.appendChild(panesContainer);
        return panesMap;
      }
    };

    Object.assign(bodyEl, helpers);
    return helpers;
  }

  /**
   * Вместо отдельного плавающего окна поверх доски, встраивает настройки скрипта
   * прямо внутрь карточки скрипта во вкладке «📜 СКРИПТЫ» главного меню!
   */
  function mountDockedWindowIntoHud(winEl, scriptEntry) {
    if (!hudShadow) return false;
    injectScriptsTabIntoHud();
    if (scriptEntry) {
      const cardSlot = hudShadow.getElementById("cc-script-dock-slot-" + scriptEntry.id);
      if (cardSlot) {
        cardSlot.innerHTML = "";
        cardSlot.appendChild(winEl);
        cardSlot.style.display = "block";
        return true;
      }
    }
    const listContainer = hudShadow.getElementById("cc-scripts-list-container");
    if (listContainer) {
      listContainer.appendChild(winEl);
      return true;
    }
    return false;
  }

  function createWindowForScript(scriptEntry, opts = {}) {
    const id = opts.id || "cc-win-" + (scriptEntry ? scriptEntry.id : Math.random().toString(36).slice(2, 7));
    if (hudShadow) {
      const existing = hudShadow.getElementById(id);
      if (existing) existing.remove();
    }

    const win = document.createElement("div");
    win.id = id;
    win.className = "cc-docked-script-win";

    const topBar = document.createElement("div");
    topBar.className = "cc-script-win-bar";

    const header = document.createElement("div");
    header.className = "cc-script-win-header";
    header.innerHTML =
      '<div style="display:flex; align-items:center; gap:7px;"><span style="width:7px; height:7px; border-radius:50%; background:#00f5d4; box-shadow:0 0 8px #00f5d4;"></span><span>' +
      (opts.title || "⚙️ НАСТРОЙКИ СКРИПТА") +
      "</span></div>";

    const foldBtn = document.createElement("button");
    foldBtn.type = "button";
    foldBtn.textContent = "Свернуть ▲";
    foldBtn.style.cssText =
      "background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.16); color:#e2e8f0; border-radius:6px; padding:3px 8px; font-size:10px; font-weight:800; cursor:pointer;";

    const body = document.createElement("div");
    body.className = "cc-script-win-body";

    let folded = false;
    foldBtn.addEventListener("click", () => {
      folded = !folded;
      body.style.display = folded ? "none" : "flex";
      foldBtn.textContent = folded ? "Развернуть ▼" : "Свернуть ▲";
    });

    header.appendChild(foldBtn);
    win.appendChild(topBar);
    win.appendChild(header);
    win.appendChild(body);

    if (!mountDockedWindowIntoHud(win, scriptEntry)) {
      const waitTimer = setInterval(() => {
        if (mountDockedWindowIntoHud(win, scriptEntry)) {
          clearInterval(waitTimer);
        }
      }, 150);
    }

    const uiHelpers = attachUiHelpersToContainer(body, scriptEntry);
    const winObj = {
      el: win,
      body,
      ...uiHelpers,
      destroy() {
        win.remove();
        if (hudShadow && scriptEntry) {
          const slot = hudShadow.getElementById("cc-script-dock-slot-" + scriptEntry.id);
          if (slot) slot.style.display = "none";
        }
      }
    };

    if (scriptEntry) {
      scriptEntry.windows.push(winObj);
    }
    return winObj;
  }

  function showUniversalBanner(scriptEntry, arg1, arg2, arg3 = {}) {
    const root = getScriptsShadow();
    let id = "cc-osd-banner-" + (scriptEntry ? scriptEntry.id : "global");
    let text = "";
    let subtext = "";
    let color = "#00f5d4";
    let position = "top-center";

    if (typeof arg1 === "object" && arg1 !== null) {
      id = arg1.id || id;
      text = arg1.text || "";
      subtext = arg1.subtext || "";
      color = arg1.accentColor || arg1.color || "#00f5d4";
      position = arg1.position || "top-center";
    } else {
      id = String(arg1 || id);
      text = String(arg2 || "");
      subtext = arg3.subtext || "";
      color = arg3.color || arg3.accentColor || "#00f5d4";
      position = arg3.position || "top-center";
    }

    const existing = root.getElementById(id);
    if (existing) existing.remove();

    const posStyles = {
      "top-center": "top: 26px; left: 50%; transform: translateX(-50%);",
      "bottom-center": "bottom: 28px; left: 50%; transform: translateX(-50%);",
      "top-left": "top: 26px; left: 26px;",
      "bottom-left": "bottom: 28px; left: 26px;"
    };

    const banner = document.createElement("div");
    banner.id = id;
    banner.style.cssText = [
      "position: fixed",
      posStyles[position] || posStyles["top-center"],
      "background: rgba(8, 11, 19, 0.95)",
      "border: 2px solid " + color,
      "border-radius: 14px",
      "padding: 10px 20px",
      "color: #ffffff",
      "box-shadow: 0 16px 40px rgba(0,0,0,0.85), 0 0 30px " + color + "55",
      "text-align: center",
      "pointer-events: none",
      "z-index: 2147483645"
    ].join(";");

    banner.innerHTML =
      '<div style="font-size:15px; font-weight:900; letter-spacing:0.6px; color:' +
      color +
      "; text-shadow:0 0 12px " +
      color +
      '88;">' +
      text +
      "</div>" +
      (subtext
        ? '<div style="font-size:10.5px; color:#cbd5e1; margin-top:3px; font-weight:600;">' + subtext + "</div>"
        : "");

    root.appendChild(banner);
    if (scriptEntry) scriptEntry.banners.add(id);
    return banner;
  }

  function hideUniversalBanner(scriptEntry, id) {
    const root = getScriptsShadow();
    if (id) {
      const el = root.getElementById(id);
      if (el) el.remove();
      if (scriptEntry) scriptEntry.banners.delete(id);
    } else if (scriptEntry) {
      scriptEntry.banners.forEach((bId) => {
        const el = root.getElementById(bId);
        if (el) el.remove();
      });
      scriptEntry.banners.clear();
    }
  }

  function applyCustomBoardTexture(scriptEntry, opts = {}) {
    const styleId = "cc-board-tex-" + (scriptEntry ? scriptEntry.id : "custom");
    const light = opts.lightColor || "#e2e8f0";
    const dark = opts.darkColor || "#1e293b";
    const glow = opts.glowColor || "rgba(0, 245, 212, 0.35)";

    const injectBoardCss = (bgUrl) => {
      const css = `
        cg-board, wc-chess-board, #board-single, .board {
          background-image: url("${bgUrl}") !important;
          background-size: 100% 100% !important;
          box-shadow: 0 0 28px ${glow} !important;
        }
        cg-board::before { display: none !important; }
      `;
      injectPageStyle(scriptEntry, styleId, css);
    };

    if (opts.imageSrc && opts.mode === "full") {
      injectBoardCss(opts.imageSrc);
      return;
    }

    const cnv = document.createElement("canvas");
    cnv.width = 512;
    cnv.height = 512;
    const ctx = cnv.getContext("2d");

    if (opts.imageSrc && opts.mode === "tile") {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        for (let r = 0; r < 8; r++) {
          for (let c = 0; c < 8; c++) {
            ctx.drawImage(img, c * 64, r * 64, 64, 64);
            ctx.fillStyle = (r + c) % 2 === 0 ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.38)";
            ctx.fillRect(c * 64, r * 64, 64, 64);
          }
        }
        injectBoardCss(cnv.toDataURL("image/png"));
      };
      img.src = opts.imageSrc;
    } else {
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          ctx.fillStyle = (r + c) % 2 === 0 ? light : dark;
          ctx.fillRect(c * 64, r * 64, 64, 64);
        }
      }
      injectBoardCss(cnv.toDataURL("image/png"));
    }
  }

  function injectPageStyle(scriptEntry, id, cssText) {
    const fullId = "cc-page-style-" + (scriptEntry ? scriptEntry.id + "-" : "") + id;
    let el = document.getElementById(fullId);
    if (!el) {
      el = document.createElement("style");
      el.id = fullId;
      document.head.appendChild(el);
    }
    el.textContent = cssText || "";
    if (scriptEntry) scriptEntry.pageStyles.add(fullId);
    return el;
  }

  function injectShadowStyle(scriptEntry, id, cssText) {
    const root = getScriptsShadow();
    const fullId = "cc-shd-style-" + (scriptEntry ? scriptEntry.id + "-" : "") + id;
    let el = root.getElementById(fullId);
    if (!el) {
      el = document.createElement("style");
      el.id = fullId;
      root.appendChild(el);
    }
    el.textContent = cssText || "";
    if (scriptEntry) scriptEntry.shadowStyles.add(fullId);
    return el;
  }

  let scriptAudioCtx = null;
  function playCustomTone(freqHz = 880, durationMs = 140, waveType = "sine") {
    try {
      const AudioClass = window.AudioContext || window.webkitAudioContext;
      if (!scriptAudioCtx || scriptAudioCtx.state === "closed") {
        scriptAudioCtx = new AudioClass();
      }
      if (scriptAudioCtx.state === "suspended") scriptAudioCtx.resume();
      const now = scriptAudioCtx.currentTime;
      const osc = scriptAudioCtx.createOscillator();
      const gain = scriptAudioCtx.createGain();
      osc.type = waveType;
      osc.frequency.setValueAtTime(Number(freqHz) || 880, now);
      gain.gain.setValueAtTime(0.14, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + (Number(durationMs) || 140) / 1000);
      osc.connect(gain);
      gain.connect(scriptAudioCtx.destination);
      osc.start(now);
      osc.stop(now + (Number(durationMs) || 140) / 1000 + 0.02);
    } catch (e) {}
  }

  function buildScopedApiForScript(scriptEntry) {
    const uiDispatcher = new Proxy(
      {},
      {
        get(_, method) {
          if (method === "createWindow") return (opts) => createWindowForScript(scriptEntry, opts);
          if (method === "showBanner") return (a1, a2, a3) => showUniversalBanner(scriptEntry, a1, a2, a3);
          if (method === "removeBanner" || method === "hideBanner") return (id) => hideUniversalBanner(scriptEntry, id);

          return (targetOrLabel, ...rest) => {
            if (targetOrLabel && (targetOrLabel instanceof HTMLElement || targetOrLabel.body)) {
              const container = targetOrLabel.body || targetOrLabel;
              const helpers = attachUiHelpersToContainer(container, scriptEntry);
              if (typeof helpers[method] === "function") return helpers[method](...rest);
            }
            const lastWin = scriptEntry.windows[scriptEntry.windows.length - 1];
            if (lastWin && typeof lastWin[method] === "function") {
              return lastWin[method](targetOrLabel, ...rest);
            }
          };
        }
      }
    );

    const api = {
      id: scriptEntry.id,
      createWindow: (opts) => createWindowForScript(scriptEntry, opts),
      getGameState: () => ({ ...trackedState }),
      ui: uiDispatcher,
      osd: {
        showBanner: (a1, a2, a3) => showUniversalBanner(scriptEntry, a1, a2, a3),
        hideBanner: (id) => hideUniversalBanner(scriptEntry, id),
        removeBanner: (id) => hideUniversalBanner(scriptEntry, id)
      },
      board: {
        getRect: getBoardRect,
        getElement: getBoardElement,
        sqToXY,
        getBestMoveText() {
          return trackedState.bestMoveUci
            ? trackedState.bestMoveUci + " (" + trackedState.bestEvalText + ")"
            : "";
        },
        setSvgLayer(svgMarkup) {
          ensureBoardOverlayElements();
          if (!boardSvgRoot) return;
          let g = boardSvgRoot.querySelector("#cc-svg-layer-" + scriptEntry.id);
          if (!g) {
            g = document.createElementNS("http://www.w3.org/2000/svg", "g");
            g.id = "cc-svg-layer-" + scriptEntry.id;
            boardSvgRoot.appendChild(g);
          }
          g.innerHTML = svgMarkup || "";
        },
        clearSvgLayer() {
          if (!boardSvgRoot) return;
          const g = boardSvgRoot.querySelector("#cc-svg-layer-" + scriptEntry.id);
          if (g) g.remove();
        },
        setCustomTexture: (opts) => applyCustomBoardTexture(scriptEntry, opts),
        resetCustomTexture() {
          const el = document.getElementById("cc-page-style-" + scriptEntry.id + "-cc-board-tex-" + scriptEntry.id);
          if (el) el.remove();
        }
      },
      css: {
        injectPage: (id, css) => injectPageStyle(scriptEntry, id, css),
        injectShadow: (id, css) => injectShadowStyle(scriptEntry, id, css),
        removePage(id) {
          const fullId = "cc-page-style-" + scriptEntry.id + "-" + id;
          const el = document.getElementById(fullId);
          if (el) el.remove();
        }
      },
      injectCSS: (id, css) => injectPageStyle(scriptEntry, id, css),
      audio: {
        playTone: playCustomTone,
        ping(type = "trap") {
          if (window.ChessFX && window.ChessFX.playTacticalAudioPing) {
            window.ChessFX.playTacticalAudioPing(type, "");
          } else {
            playCustomTone(1046.5, 130, "sine");
          }
        }
      },
      storage: {
        get(key, fallback) {
          try {
            const raw = localStorage.getItem("cc_script_" + scriptEntry.id + "_" + key);
            return raw !== null ? JSON.parse(raw) : fallback;
          } catch (e) {
            return fallback;
          }
        },
        set(key, val) {
          try {
            localStorage.setItem("cc_script_" + scriptEntry.id + "_" + key, JSON.stringify(val));
          } catch (e) {}
        }
      },
      setInterval(fn, ms) {
        const id = window.setInterval(fn, ms);
        scriptEntry.intervals.push(id);
        return id;
      },
      setTimeout(fn, ms) {
        const id = window.setTimeout(fn, ms);
        scriptEntry.timeouts.push(id);
        return id;
      },
      addEventListener(target, type, fn, opts) {
        const t = target || window;
        t.addEventListener(type, fn, opts);
        scriptEntry.cleanupListeners.push({ target: t, type, fn, opts });
      },
      on(eventName, fn) {
        if (typeof fn === "function") {
          scriptEntry.dynamicHooks[eventName] = fn;
        }
      }
    };

    return api;
  }

  function cleanupScriptResources(scriptEntry) {
    scriptEntry.windows.forEach((w) => {
      try { w.destroy(); } catch (e) {}
    });
    scriptEntry.windows = [];

    hideUniversalBanner(scriptEntry);

    scriptEntry.intervals.forEach((id) => clearInterval(id));
    scriptEntry.intervals = [];

    scriptEntry.timeouts.forEach((id) => clearTimeout(id));
    scriptEntry.timeouts = [];

    scriptEntry.cleanupListeners.forEach((item) => {
      try { item.target.removeEventListener(item.type, item.fn, item.opts); } catch (e) {}
    });
    scriptEntry.cleanupListeners = [];

    scriptEntry.pageStyles.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
    scriptEntry.pageStyles.clear();

    if (scriptsShadow) {
      scriptEntry.shadowStyles.forEach((id) => {
        const el = scriptsShadow.getElementById(id);
        if (el) el.remove();
      });
    }
    scriptEntry.shadowStyles.clear();

    if (boardSvgRoot) {
      const g = boardSvgRoot.querySelector("#cc-svg-layer-" + scriptEntry.id);
      if (g) g.remove();
    }
    if (boardCanvasCtx) {
      boardCanvasCtx.clearRect(0, 0, 800, 800);
    }
  }

  function toggleScriptState(scriptId, enabled, save = true) {
    const item = registeredScripts.get(scriptId);
    if (!item || item.enabled === enabled) return;

    item.enabled = enabled;
    const badge = hudShadow && hudShadow.getElementById("cc-script-badge-" + scriptId);
    const chk = hudShadow && hudShadow.getElementById("cc-script-chk-" + scriptId);

    if (chk) chk.checked = enabled;
    if (badge) {
      badge.textContent = enabled ? "АКТИВЕН" : "ВЫКЛ";
      badge.style.color = enabled ? "#00f5d4" : "#94a3b8";
    }

    try {
      if (enabled) {
        scanBoardAndHudState();
        if (typeof item.onEnable === "function") item.onEnable(item.scopedApi);
      } else {
        if (typeof item.onDisable === "function") item.onDisable(item.scopedApi);
        cleanupScriptResources(item);
      }
    } catch (err) {
      console.error("[CC Script Error in " + scriptId + "]:", err);
    }

    if (save) {
      try {
        chrome.storage?.local?.get(["cc_enabled_scripts"], (res) => {
          const map = (res && res.cc_enabled_scripts) || {};
          map[scriptId] = enabled;
          chrome.storage.local.set({ cc_enabled_scripts: map });
        });
      } catch (e) {}
    }
  }

  function renderScriptCardInMainHud(scriptObj) {
    if (!hudShadow) return;
    const listEl = hudShadow.getElementById("cc-scripts-list-container");
    if (!listEl) return;

    const existing = hudShadow.getElementById("cc-script-card-" + scriptObj.id);
    if (existing) existing.remove();

    const card = document.createElement("div");
    card.className = "cc-glass-card";
    card.id = "cc-script-card-" + scriptObj.id;
    card.style.borderLeft = "3.5px solid #00f5d4";

    card.innerHTML =
      '<div class="cc-section-title">' +
      "<span>📜 " +
      scriptObj.name +
      " <small style='color:#94a3b8;'>v" +
      (scriptObj.version || "2.0") +
      "</small></span>" +
      "<span id='cc-script-badge-" +
      scriptObj.id +
      "' style='font-size:9.5px; color:" +
      (scriptObj.enabled ? "#00f5d4" : "#94a3b8") +
      ";'>" +
      (scriptObj.enabled ? "АКТИВЕН" : "ВЫКЛ") +
      "</span>" +
      "</div>" +
      "<div style='font-size:11px; color:#cbd5e1; margin-bottom:8px; line-height:1.4;'>" +
      (scriptObj.description || "Пользовательский скрипт с встроенными настройками прямо в этой вкладке.") +
      "</div>" +
      '<div class="cc-Switch-row" style="padding:4px 0 0 0; border:none;">' +
      "<span style='font-weight:800; color:#fff;'>⚡ Включить скрипт (настройки откроются ниже)</span>" +
      "<input type='checkbox' id='cc-script-chk-" +
      scriptObj.id +
      "' " +
      (scriptObj.enabled ? "checked" : "") +
      ">" +
      "</div>" +
      "<div id='cc-script-dock-slot-" +
      scriptObj.id +
      "' style='display:none;'></div>";

    listEl.appendChild(card);

    // Если у скрипта уже было создано окно настроек — монтируем его в слот карточки
    if (scriptObj.enabled && scriptObj.windows.length > 0) {
      const slot = card.querySelector("#cc-script-dock-slot-" + scriptObj.id);
      if (slot) {
        slot.innerHTML = "";
        slot.appendChild(scriptObj.windows[scriptObj.windows.length - 1].el);
        slot.style.display = "block";
      }
    }

    const chk = card.querySelector("#cc-script-chk-" + scriptObj.id);
    if (chk) {
      chk.addEventListener("change", (e) => {
        toggleScriptState(scriptObj.id, e.target.checked, true);
      });
    }
  }

  function injectScriptsTabIntoHud() {
    if (!hudShadow) return false;
    const targetShadow = hudShadow;
    const navList = targetShadow.querySelector(".cc-nav-list");
    const mainView = targetShadow.querySelector(".cc-main-view");
    if (!navList || !mainView) return false;
    if (targetShadow.getElementById("cc-pane-scripts")) return true;

    // Инжектим стили встроенных панелей скриптов в главный ShadowRoot
    const dockedStyleEl = document.createElement("style");
    dockedStyleEl.textContent = DOCKED_SCRIPT_STYLES;
    targetShadow.appendChild(dockedStyleEl);

    const tabBtn = document.createElement("button");
    tabBtn.className = "cc-tab-btn";
    tabBtn.dataset.tab = "scripts";
    tabBtn.innerHTML = '<span class="cc-tab-icon">📜</span> СКРИПТЫ';
    navList.appendChild(tabBtn);

    const pane = document.createElement("div");
    pane.className = "cc-tab-pane";
    pane.id = "cc-pane-scripts";
    pane.innerHTML =
      '<div class="cc-glass-card" style="border-left:3.5px solid #c77dff; background:linear-gradient(135deg, rgba(199,125,255,0.14), rgba(0,245,212,0.08));">' +
      '<div class="cc-section-title" style="color:#c77dff;">' +
      "<span>🧩 МЕНЕДЖЕР СКРИПТОВ (ВСТРОЕННЫЕ ВКЛАДКИ)</span>" +
      "<span id='cc-script-loader-status' style='color:#00f5d4;'>SDK v2.0</span>" +
      "</div>" +
      "<div style='font-size:11px; color:#cbd5e1; line-height:1.4; margin-bottom:10px;'>" +
      "Настройки каждого включенного скрипта открываются <strong>прямо внутри этой вкладки</strong>, не перекрывая шахматную доску. Вы можете загрузить любой <code>.js</code> скрипт из памяти телефона:" +
      "</div>" +
      '<div class="cc-actions-bar">' +
      '<button class="cc-btn cc-btn-primary" id="cc-add-script-file-btn">📂 ЗАГРУЗИТЬ .JS СКРИПТ</button>' +
      '<button class="cc-btn cc-btn-danger" id="cc-reset-script-files-btn">🗑 СБРОСИТЬ СПИСОК</button>' +
      "</div>" +
      '<input type="file" id="cc-script-file-picker" accept=".js" multiple style="display:none;" />' +
      "</div>" +
      '<div id="cc-scripts-list-container" style="display:flex; flex-direction:column; gap:10px;"></div>';

    mainView.appendChild(pane);

    const addBtn = pane.querySelector("#cc-add-script-file-btn");
    const resetBtn = pane.querySelector("#cc-reset-script-files-btn");
    const fileInp = pane.querySelector("#cc-script-file-picker");
    const statusEl = pane.querySelector("#cc-script-loader-status");

    if (addBtn && fileInp) {
      addBtn.addEventListener("click", () => {
        fileInp.value = "";
        fileInp.click();
      });

      fileInp.addEventListener("change", async (e) => {
        const files = Array.from(e.target.files || []);
        let loadedCount = 0;
        for (const f of files) {
          const ok = await loadScriptFileFromFolder(f.name, true);
          if (ok) loadedCount++;
        }
        if (statusEl && loadedCount > 0) {
          statusEl.textContent = "✅ ПОДКЛЮЧЕНО: " + loadedCount;
          statusEl.style.color = "#38b000";
        }
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        try {
          chrome.storage?.local?.set({ cc_custom_script_files: [] }, () => {
            if (statusEl) {
              statusEl.textContent = "🔄 СПИСОК ОЧИЩЕН";
              statusEl.style.color = "#ff4d94";
            }
          });
        } catch (e) {}
      });
    }

    tabBtn.addEventListener("click", () => {
      targetShadow.querySelectorAll(".cc-tab-btn").forEach((b) => {
        b.classList.toggle("active", b === tabBtn);
      });
      targetShadow.querySelectorAll(".cc-tab-pane").forEach((p) => {
        p.classList.toggle("active", p === pane);
      });
    });

    targetShadow.querySelectorAll(".cc-tab-btn").forEach((b) => {
      if (b !== tabBtn) {
        b.addEventListener("click", () => {
          tabBtn.classList.remove("active");
          pane.classList.remove("active");
        });
      }
    });

    registeredScripts.forEach((scriptObj) => {
      renderScriptCardInMainHud(scriptObj);
    });

    return true;
  }

  let lastFrameTs = performance.now();
  function run60FpsLoop(now) {
    const dt = Math.min(0.1, (now - lastFrameTs) / 1000);
    lastFrameTs = now;

    let anyFrameHookActive = false;
    registeredScripts.forEach((s) => {
      if (s.enabled && (typeof s.onFrame === "function" || typeof s.dynamicHooks.onFrame === "function")) {
        anyFrameHookActive = true;
      }
    });

    if (anyFrameHookActive) {
      const rect = ensureBoardOverlayElements();
      if (rect && boardCanvasCtx) {
        boardCanvasCtx.clearRect(0, 0, 800, 800);
        const snapshot = { ...trackedState };
        registeredScripts.forEach((s) => {
          if (!s.enabled) return;
          const fn = s.onFrame || s.dynamicHooks.onFrame;
          if (typeof fn === "function") {
            try {
              boardCanvasCtx.save();
              fn(s.scopedApi, boardCanvasCtx, dt, snapshot);
              boardCanvasCtx.restore();
            } catch (e) {
              boardCanvasCtx.restore();
            }
          }
        });
      }
    }

    requestAnimationFrame(run60FpsLoop);
  }
  requestAnimationFrame(run60FpsLoop);

  setInterval(() => {
    injectScriptsTabIntoHud();
    scanBoardAndHudState();
    ensureBoardOverlayElements();

    const snapshot = { ...trackedState };
    const movePairSig = (snapshot.lastMoveFrom || "") + "-" + (snapshot.lastMoveTo || "") + "-" + snapshot.moveCount;
    const evalSig = snapshot.bestMoveUci + "|" + snapshot.bestEvalText;

    const isNewMove = Boolean(snapshot.lastMoveFrom && movePairSig !== lastMovePairSig);
    if (isNewMove) lastMovePairSig = movePairSig;

    const isNewEval = Boolean(snapshot.bestMoveUci && evalSig !== lastEvalSig);
    if (isNewEval) lastEvalSig = evalSig;

    registeredScripts.forEach((s) => {
      if (!s.enabled) return;
      try {
        if (typeof s.onTick === "function") s.onTick(s.scopedApi, snapshot);
        if (typeof s.dynamicHooks.onTick === "function") s.dynamicHooks.onTick(snapshot);

        if (isNewMove) {
          if (typeof s.onMove === "function") s.onMove(s.scopedApi, snapshot);
          if (typeof s.dynamicHooks.onMove === "function") s.dynamicHooks.onMove(snapshot);
          if (typeof s.dynamicHooks.onMoveChanged === "function") s.dynamicHooks.onMoveChanged(snapshot);
        }

        if (isNewEval) {
          if (typeof s.onEvalUpdate === "function") s.onEvalUpdate(s.scopedApi, snapshot);
          if (typeof s.dynamicHooks.onEvalUpdate === "function") s.dynamicHooks.onEvalUpdate(snapshot);
        }
      } catch (e) {}
    }
  );
  }, 250);

  const globalEntry = {
    id: "global",
    windows: [],
    banners: new Set(),
    intervals: [],
    timeouts: [],
    cleanupListeners: [],
    pageStyles: new Set(),
    shadowStyles: new Set(),
    dynamicHooks: {}
  };
  const defaultGlobalApi = buildScopedApiForScript(globalEntry);

  window.CC = {
    __v2Initialized: true,
    ...defaultGlobalApi,
    loadScriptFile: loadScriptFileFromFolder,
    registerScript(config) {
      if (!config || !config.id) return;
      const entry = {
        id: config.id,
        name: config.name || config.id,
        version: config.version || "2.0.0",
        author: config.author || "Community",
        description: config.description || "",
        enabled: false,
        onEnable: config.onEnable,
        onDisable: config.onDisable,
        onTick: config.onTick,
        onMove: config.onMove,
        onEvalUpdate: config.onEvalUpdate,
        onFrame: config.onFrame,
        windows: [],
        banners: new Set(),
        intervals: [],
        timeouts: [],
        cleanupListeners: [],
        pageStyles: new Set(),
        shadowStyles: new Set(),
        dynamicHooks: {}
      };
      entry.scopedApi = buildScopedApiForScript(entry);
      registeredScripts.set(entry.id, entry);
      renderScriptCardInMainHud(entry);

      try {
        chrome.storage?.local?.get(["cc_enabled_scripts"], (res) => {
          const map = (res && res.cc_enabled_scripts) || {};
          if (map[entry.id]) {
            toggleScriptState(entry.id, true, false);
          }
        });
      } catch (e) {}
    }
  };

  autoLoadSavedScriptFiles();
})();