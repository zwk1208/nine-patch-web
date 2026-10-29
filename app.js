(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const els = {
    emptyState: $("#emptyState"), editorWrap: $("#editorWrap"), canvasStack: $("#canvasStack"),
    imageCanvas: $("#imageCanvas"), canvasOverlay: $("#canvasOverlay"), canvasStage: $("#canvasStage"),
    outputSize: $("#outputSize"),
    exportButton: $("#exportButton"), compiledExportButton: $("#compiledExportButton"),
    rawZipExportButton: $("#rawZipExportButton"), compiledZipExportButton: $("#compiledZipExportButton"),
    resetButton: $("#resetButton"), toast: $("#toast"),
    previewTextToggle: $("#previewTextToggle"),
    helpButton: $("#helpButton"), helpDialog: $("#helpDialog"),
    helpCloseButton: $("#helpCloseButton"), helpDoneButton: $("#helpDoneButton"),
    zoomLabel: $("#zoomLabel"), modeLabel: $("#modeLabel"), zoomIn: $("#zoomIn"),
    zoomOut: $("#zoomOut"), zoomReset: $("#zoomReset"), dragReadout: $("#dragReadout")
  };
  const inputs = { left: $("#leftInput"), right: $("#rightInput"), top: $("#topInput"), bottom: $("#bottomInput") };
  const state = {
    image: null, file: null, imageUrl: "", loadId: 0, loading: false, mode: "stretch", zoom: 1, displayScale: 1,
    sourceWidth: 0, sourceHeight: 0,
    stretch: { left: 0, right: 0, top: 0, bottom: 0 },
    content: { left: 0, right: 0, top: 0, bottom: 0 },
    previewSize: { width: 0, height: 0 },
    editorLayout: { scale: 1, width: 0, height: 0, offsetX: 0, offsetY: 0 }
  };
  let toastTimer;

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2600);
  }

  function getSafeBaseName() {
    const original = state.file?.name || "image";
    const withoutExtension = original.replace(/\.[^.]+$/, "");
    const withoutPatchSuffix = withoutExtension
      .replace(/(?:[.-](?:raw|compiled))?\.9$/i, "")
      .replace(/[.-](?:raw|compiled)$/i, "");
    const safe = withoutPatchSuffix
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim();
    return safe || "image";
  }

  function writeUint32BE(view, offset, value) {
    view.setUint32(offset, value >>> 0, false);
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makePngChunk(type, data) {
    const typeBytes = new TextEncoder().encode(type);
    const crcInput = new Uint8Array(typeBytes.length + data.length);
    crcInput.set(typeBytes); crcInput.set(data, typeBytes.length);
    const chunk = new Uint8Array(12 + data.length);
    const view = new DataView(chunk.buffer);
    writeUint32BE(view, 0, data.length);
    chunk.set(typeBytes, 4); chunk.set(data, 8);
    writeUint32BE(view, 8 + data.length, crc32(crcInput));
    return chunk;
  }

  function patchMetrics() {
    const scale = 1;
    const width = Math.max(1, Math.round(state.sourceWidth * scale));
    const height = Math.max(1, Math.round(state.sourceHeight * scale));
    const stretch = {
      left: Math.round(state.stretch.left * scale),
      right: Math.round(state.stretch.right * scale),
      top: Math.round(state.stretch.top * scale),
      bottom: Math.round(state.stretch.bottom * scale)
    };
    const content = {
      left: Math.round(state.content.left * scale),
      right: Math.round(state.content.right * scale),
      top: Math.round(state.content.top * scale),
      bottom: Math.round(state.content.bottom * scale)
    };
    stretch.left = clamp(stretch.left, 0, Math.max(0, width - 1));
    stretch.right = clamp(stretch.right, 0, Math.max(0, width - stretch.left - 1));
    stretch.top = clamp(stretch.top, 0, Math.max(0, height - 1));
    stretch.bottom = clamp(stretch.bottom, 0, Math.max(0, height - stretch.top - 1));
    content.left = clamp(content.left, 0, Math.max(0, width - 1));
    content.right = clamp(content.right, 0, Math.max(0, width - content.left - 1));
    content.top = clamp(content.top, 0, Math.max(0, height - 1));
    content.bottom = clamp(content.bottom, 0, Math.max(0, height - content.top - 1));
    return { width, height, stretch, content };
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }

  function downloadBlob(blob, filename) {
    const anchor = document.createElement("a");
    const url = URL.createObjectURL(blob);
    anchor.href = url;
    anchor.download = filename;
    anchor.setAttribute("download", filename);
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function makeCompiledNinePatch() {
    const metrics = patchMetrics();
    const cleanCanvas = document.createElement("canvas");
    cleanCanvas.width = metrics.width; cleanCanvas.height = metrics.height;
    cleanCanvas.getContext("2d").drawImage(state.image, 0, 0, metrics.width, metrics.height);
    const cleanBlob = await canvasToBlob(cleanCanvas);
    if (!cleanBlob) throw new Error("Unable to encode compiled PNG");
    const png = new Uint8Array(await cleanBlob.arrayBuffer());
    const data = new Uint8Array(84);
    const view = new DataView(data.buffer);
    data[0] = 0; data[1] = 2; data[2] = 2; data[3] = 9;
    writeUint32BE(view, 4, 32); writeUint32BE(view, 8, 40);
    writeUint32BE(view, 12, metrics.content.left);
    writeUint32BE(view, 16, metrics.content.right);
    writeUint32BE(view, 20, metrics.content.top);
    writeUint32BE(view, 24, metrics.content.bottom);
    writeUint32BE(view, 28, 48);
    writeUint32BE(view, 32, metrics.stretch.left);
    writeUint32BE(view, 36, metrics.width - metrics.stretch.right);
    writeUint32BE(view, 40, metrics.stretch.top);
    writeUint32BE(view, 44, metrics.height - metrics.stretch.bottom);
    for (let offset = 48; offset < 84; offset += 4) writeUint32BE(view, offset, 1);
    const chunk = makePngChunk("npTc", data);
    let offset = 8, insertAt = png.length - 12;
    while (offset + 12 <= png.length) {
      const length = new DataView(png.buffer, png.byteOffset + offset, 4).getUint32(0);
      const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
      if (type === "IEND") { insertAt = offset; break; }
      offset += 12 + length;
    }
    const compiled = new Uint8Array(png.length + chunk.length);
    compiled.set(png.subarray(0, insertAt));
    compiled.set(chunk, insertAt);
    compiled.set(png.subarray(insertAt), insertAt + chunk.length);
    return new Blob([compiled], { type: "image/png" });
  }

  async function exportCompiledNinePatch() {
    try {
      const blobs = await getCurrentExportBlobs();
      if (!blobs) return;
      const baseName = getSafeBaseName();
      downloadBlob(blobs.compiledBlob, `${baseName}-compiled.9.png`);
      showToast(`已导出 ${baseName}-compiled.9.png；外围标记线已写入 npTc chunk。`);
    } catch (error) {
      console.error("Compiled nine-patch export failed", error);
      showToast("编译 .9.png 导出失败，请重试。");
    }
  }

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function activeEdges() { return state.mode === "stretch" ? state.stretch : state.content; }
  function edgeMax(edge) { return edge === "left" || edge === "right" ? state.sourceWidth : state.sourceHeight; }

  function syncInputs() {
    const edges = activeEdges();
    inputs.left.value = Math.round(edges.left);
    inputs.right.value = Math.round(edges.right);
    inputs.top.value = Math.round(edges.top);
    inputs.bottom.value = Math.round(edges.bottom);
    els.modeLabel.textContent = state.mode === "stretch" ? "拉伸区域" : "内容区域";
  }

  function setEdge(edge, rawValue) {
    if (!state.image) return;
    const edges = activeEdges();
    const max = edgeMax(edge);
    const opposite = edge === "left" ? "right" : edge === "right" ? "left" : edge === "top" ? "bottom" : "top";
    const value = clamp(Number(rawValue) || 0, 0, Math.max(0, max - edges[opposite] - 1));
    edges[edge] = value;
    syncInputs();
    renderAll(false);
  }

  function normalizedEdge(target) {
    return target.replace("content", "").toLowerCase();
  }

  function edgeLabel(edge) {
    return { left: "左", right: "右", top: "上", bottom: "下" }[edge] || edge;
  }

  function updateDrag(event) {
    if (!drag || !state.image) return;
    const isX = drag.edge === "left" || drag.edge === "right";
    const rect = els.canvasStack.getBoundingClientRect();
    const imagePosition = clamp(
      isX ? (event.clientX - rect.left) / state.displayScale : (event.clientY - rect.top) / state.displayScale,
      0,
      isX ? state.sourceWidth : state.sourceHeight
    );
    const size = isX ? state.sourceWidth : state.sourceHeight;
    const value = drag.edge === "left" || drag.edge === "top" ? imagePosition : size - imagePosition;
    setEdgeForMode(drag.mode, drag.edge, value);
    const markerName = drag.mode === "stretch" ? "拉伸" : "内容";
    els.dragReadout.textContent = `${markerName} · ${edgeLabel(drag.edge)} ${Math.round(state[drag.mode][drag.edge])} px`;
    els.dragReadout.classList.add("visible");
  }

  function setEdgeForMode(mode, edge, rawValue) {
    const previousMode = state.mode;
    state.mode = mode;
    setEdge(edge, rawValue);
    state.mode = previousMode;
    syncInputs();
  }

  function resetMarkers() {
    state.stretch = { left: 0, right: 0, top: 0, bottom: 0 };
    state.content = { left: 0, right: 0, top: 0, bottom: 0 };
    syncInputs(); renderAll(false);
  }

  function updateEditorFit() {
    if (!state.image) return;
    const maxWidth = Math.max(180, els.canvasStage?.clientWidth || 800);
    const maxHeight = Math.max(180, els.canvasStage?.clientHeight || 500);
    const scale = Math.min(1, maxWidth * .78 / state.sourceWidth, maxHeight * .78 / state.sourceHeight) * state.zoom;
    const width = Math.max(1, Math.round(state.sourceWidth * scale));
    const height = Math.max(1, Math.round(state.sourceHeight * scale));
    state.displayScale = scale;
    state.editorLayout = {
      scale, width, height,
      offsetX: Math.max(0, (maxWidth - width) / 2),
      offsetY: Math.max(0, (maxHeight - height) / 2)
    };
    els.imageCanvas.style.width = `${width}px`;
    els.imageCanvas.style.height = `${height}px`;
    els.canvasStack.style.width = `${width}px`;
    els.canvasStack.style.height = `${height}px`;
  }

  function renderCanvas(fit = true) {
    if (!state.image) return;
    const canvas = els.imageCanvas;
    if (canvas.width !== state.sourceWidth) canvas.width = state.sourceWidth;
    if (canvas.height !== state.sourceHeight) canvas.height = state.sourceHeight;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(state.image, 0, 0);
    if (fit) updateEditorFit();
    els.canvasOverlay.style.transform = "none";
    updateGuideLayer();
    positionGuides();
  }

  function updateGuideLayer() {
    els.canvasOverlay.classList.toggle("content-mode", state.mode === "content");
  }

  function positionGuides() {
    if (!state.image) return;
    const s = state.displayScale;
    const place = (selector, value, axis, opposite = false) => {
      const node = document.querySelector(selector);
      if (axis === "x") {
        node.style.left = `${value * s}px`;
        node.style.right = "auto";
      } else {
        node.style.top = `${value * s}px`;
        node.style.bottom = "auto";
      }
    };
    const stretch = state.stretch, content = state.content;
    const fill = document.querySelector(".content-area-fill");
    fill.style.left = `${content.left * s}px`;
    fill.style.top = `${content.top * s}px`;
    fill.style.width = `${Math.max(0, state.sourceWidth - content.left - content.right) * s}px`;
    fill.style.height = `${Math.max(0, state.sourceHeight - content.top - content.bottom) * s}px`;
    place(".guide-left", stretch.left, "x");
    place(".guide-right", state.sourceWidth - stretch.right, "x");
    place(".guide-top", stretch.top, "y");
    place(".guide-bottom", state.sourceHeight - stretch.bottom, "y");
    place(".content-left", content.left, "x");
    place(".content-right", state.sourceWidth - content.right, "x");
    place(".content-top", content.top, "y");
    place(".content-bottom", state.sourceHeight - content.bottom, "y");
  }

  function drawNinePatch(targetCanvas, targetWidth, targetHeight) {
    if (!state.image) return;
    const sourceWidth = state.sourceWidth, sourceHeight = state.sourceHeight;
    const stretch = state.stretch;
    const left = clamp(Math.round(stretch.left), 0, sourceWidth - 1);
    const right = clamp(Math.round(stretch.right), 0, sourceWidth - left - 1);
    const top = clamp(Math.round(stretch.top), 0, sourceHeight - 1);
    const bottom = clamp(Math.round(stretch.bottom), 0, sourceHeight - top - 1);
    const srcStretchWidth = Math.max(1, sourceWidth - left - right);
    const srcStretchHeight = Math.max(1, sourceHeight - top - bottom);
    const minWidth = left + right + 1, minHeight = top + bottom + 1;
    const width = Math.max(minWidth, Math.round(targetWidth));
    const height = Math.max(minHeight, Math.round(targetHeight));
    targetCanvas.width = width; targetCanvas.height = height;
    const ctx = targetCanvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    const centerWidth = Math.max(1, width - left - right);
    const centerHeight = Math.max(1, height - top - bottom);
    const draw = (sx, sy, sw, sh, dx, dy, dw, dh) => ctx.drawImage(state.image, sx, sy, sw, sh, dx, dy, dw, dh);
    draw(0, 0, left, top, 0, 0, left, top);
    draw(left, 0, srcStretchWidth, top, left, 0, centerWidth, top);
    draw(sourceWidth - right, 0, right, top, width - right, 0, right, top);
    draw(0, top, left, srcStretchHeight, 0, top, left, centerHeight);
    draw(left, top, srcStretchWidth, srcStretchHeight, left, top, centerWidth, centerHeight);
    draw(sourceWidth - right, top, right, srcStretchHeight, width - right, top, right, centerHeight);
    draw(0, sourceHeight - bottom, left, bottom, 0, height - bottom, left, bottom);
    draw(left, sourceHeight - bottom, srcStretchWidth, bottom, left, height - bottom, centerWidth, bottom);
    draw(sourceWidth - right, sourceHeight - bottom, right, bottom, width - right, height - bottom, right, bottom);
  }

  function renderEffectPreview() {
    if (!state.image) return;
    const stage = $("#effectStage");
    const canvas = $("#effectCanvas");
    const wrap = $("#resizePreviewWrap");
    const width = state.previewSize.width;
    const height = state.previewSize.height;
    drawNinePatch(canvas, width, height);
    if (els.previewTextToggle.checked) drawPreviewText(canvas);
    const scale = Math.min(.84 * stage.clientWidth / width, .78 * stage.clientHeight / height, 1);
    wrap.style.width = `${Math.max(1, Math.round(width * scale))}px`;
    wrap.style.height = `${Math.max(1, Math.round(height * scale))}px`;
    $("#effectSize").textContent = `${canvas.width} × ${canvas.height}px`;
  }

  function drawPreviewText(canvas) {
    const ctx = canvas.getContext("2d");
    const text = "这是一段用于展示 Android .9 图拉伸效果的完整示例文案，文字会随着内容区域的宽度和高度自动换行、缩放并保持自然间距，方便观察图片在不同尺寸下的显示效果。";
    const content = {
      left: clamp(Math.round(state.content.left), 0, Math.max(0, canvas.width - 1)),
      right: clamp(Math.round(state.content.right), 0, Math.max(0, canvas.width - 1)),
      top: clamp(Math.round(state.content.top), 0, Math.max(0, canvas.height - 1)),
      bottom: clamp(Math.round(state.content.bottom), 0, Math.max(0, canvas.height - 1))
    };
    content.right = Math.min(content.right, Math.max(0, canvas.width - content.left - 1));
    content.bottom = Math.min(content.bottom, Math.max(0, canvas.height - content.top - 1));
    const contentWidth = Math.max(1, canvas.width - content.left - content.right);
    const contentHeight = Math.max(1, canvas.height - content.top - content.bottom);
    const padding = Math.max(2, Math.round(Math.min(contentWidth, contentHeight) * .004));
    ctx.save();
    ctx.fillStyle = "rgba(23, 32, 51, .4)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(37, 99, 235, .2)";
    ctx.fillRect(content.left, content.top, contentWidth, contentHeight);
    ctx.strokeStyle = "rgba(37, 99, 235, .78)";
    ctx.lineWidth = Math.max(1, Math.round(Math.min(canvas.width, canvas.height) * .012));
    ctx.strokeRect(
      content.left + ctx.lineWidth / 2,
      content.top + ctx.lineWidth / 2,
      Math.max(0, contentWidth - ctx.lineWidth),
      Math.max(0, contentHeight - ctx.lineWidth)
    );
    ctx.beginPath();
    ctx.rect(content.left, content.top, contentWidth, contentHeight);
    ctx.clip();
    let fontSize = clamp(Math.round(Math.min(contentWidth, contentHeight) * .14), 16, 48);
    let lines = [];
    let lineHeight = 0;
    const maxTextWidth = Math.max(1, contentWidth - padding * 2);
    const wrapText = () => {
      ctx.font = `500 ${fontSize}px "Microsoft YaHei", sans-serif`;
      const result = [];
      let line = "";
      for (const character of text) {
        const candidate = line + character;
        if (line && ctx.measureText(candidate).width > maxTextWidth) {
          result.push(line);
          line = character;
        } else {
          line = candidate;
        }
      }
      if (line) result.push(line);
      return result;
    };
    do {
      lines = wrapText();
      lineHeight = Math.round(fontSize * 1.35);
      if (lines.length * lineHeight <= Math.max(1, contentHeight - padding * 2) || fontSize <= 14) break;
      fontSize -= 2;
    } while (fontSize > 14);
    ctx.font = `500 ${fontSize}px "Microsoft YaHei", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255, 255, 255, .98)";
    ctx.strokeStyle = "rgba(23, 32, 51, .55)";
    ctx.lineWidth = Math.max(1, fontSize * .045);
    ctx.shadowColor = "rgba(0, 0, 0, .4)";
    ctx.shadowBlur = Math.max(2, fontSize * .12);
    const textBlockHeight = lines.length * lineHeight;
    const startY = content.top + Math.max(padding, (contentHeight - textBlockHeight) * .35) + lineHeight / 2;
    const lineLeft = content.left + padding;
    const lineWidth = Math.max(1, contentWidth - padding * 2);
    for (let index = 0; index < lines.length; index += 1) {
      const y = startY + index * lineHeight;
      const characters = Array.from(lines[index]);
      const characterWidths = characters.map((character) => ctx.measureText(character).width);
      const textWidth = characterWidths.reduce((total, width) => total + width, 0);
      const gap = characters.length > 1
        ? Math.max(0, (lineWidth - textWidth) / (characters.length - 1))
        : 0;
      let x = lineLeft;
      for (let characterIndex = 0; characterIndex < characters.length; characterIndex += 1) {
        const character = characters[characterIndex];
        const characterWidth = characterWidths[characterIndex];
        ctx.textAlign = "left";
        ctx.strokeText(character, x, y);
        ctx.fillText(character, x, y);
        x += characterWidth + gap;
      }
    }
    ctx.restore();
  }

  function getInitialPreviewSize(width, height) {
    const stage = $("#effectStage");
    const availableWidth = Math.max(180, (stage.clientWidth || 360) * .78);
    const availableHeight = Math.max(180, (stage.clientHeight || 420) * .68);
    const scale = Math.min(1.5, availableWidth / width, availableHeight / height);
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    };
  }

  function createRawNinePatchCanvas() {
    const metrics = patchMetrics();
    const output = document.createElement("canvas");
    output.width = metrics.width + 2; output.height = metrics.height + 2;
    const ctx = output.getContext("2d");
    ctx.clearRect(0, 0, output.width, output.height);
    ctx.drawImage(state.image, 1, 1, metrics.width, metrics.height);
    const putLine = (x1, y1, x2, y2) => {
      ctx.fillStyle = "#000";
      ctx.fillRect(x1, y1, x2 - x1 || 1, y2 - y1 || 1);
    };
    const s = metrics.stretch, c = metrics.content;
    if (s.left < metrics.width - s.right) putLine(1 + s.left, 0, 1 + metrics.width - s.right, 1);
    if (s.top < metrics.height - s.bottom) putLine(0, 1 + s.top, 1, 1 + metrics.height - s.bottom);
    if (c.left < metrics.width - c.right) putLine(1 + c.left, output.height - 1, 1 + metrics.width - c.right, output.height);
    if (c.top < metrics.height - c.bottom) putLine(output.width - 1, 1 + c.top, output.width, 1 + metrics.height - c.bottom);
    return output;
  }

  function renderExportCanvas() {
    if (!state.image) return;
    const output = createRawNinePatchCanvas();
    els.outputSize.textContent = `${output.width} × ${output.height}px`;
    state.exportCanvas = output;
  }

  function renderAll(fitEditor = true) { renderCanvas(fitEditor); renderExportCanvas(); renderEffectPreview(); }

  function loadFile(file) {
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) {
      showToast("请选择 PNG、JPG 或 WebP 图片。"); return;
    }
    const url = URL.createObjectURL(file);
    const loadId = ++state.loadId;
    if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
    state.image = null;
    state.file = null;
    state.imageUrl = "";
    state.exportCanvas = null;
    state.sourceWidth = 0;
    state.sourceHeight = 0;
    state.editorLayout = { scale: 1, width: 0, height: 0, offsetX: 0, offsetY: 0 };
    state.stretch = { left: 0, right: 0, top: 0, bottom: 0 };
    state.content = { left: 0, right: 0, top: 0, bottom: 0 };
    state.previewSize = { width: 0, height: 0 };
    const effectCanvas = $("#effectCanvas");
    $("#resizePreviewWrap").classList.add("hidden");
    effectCanvas.width = 1;
    effectCanvas.height = 1;
    effectCanvas.getContext("2d").clearRect(0, 0, 1, 1);
    $("#effectSize").textContent = "";
    els.outputSize.textContent = "—";
    state.loading = true;
    els.emptyState.classList.remove("hidden");
    els.editorWrap.classList.add("hidden");
    els.exportButton.disabled = true;
    els.compiledExportButton.disabled = true;
    els.rawZipExportButton.disabled = true;
    els.compiledZipExportButton.disabled = true;
    els.resetButton.disabled = true;
    showToast("图片正在加载，请稍候。");
    const image = new Image();
    image.onload = () => {
      if (loadId !== state.loadId) { URL.revokeObjectURL(url); return; }
      if (image.naturalWidth > 4096 || image.naturalHeight > 4096) showToast("图片较大，仍可继续编辑，但处理可能较慢。");
      if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
      state.loading = false;
      state.image = image; state.file = file; state.sourceWidth = image.naturalWidth; state.sourceHeight = image.naturalHeight;
      state.imageUrl = url;
      state.stretch = { left: 0, right: 0, top: 0, bottom: 0 };
      state.content = { left: 0, right: 0, top: 0, bottom: 0 };
      state.previewSize = getInitialPreviewSize(image.naturalWidth, image.naturalHeight);
      els.emptyState.classList.add("hidden"); els.editorWrap.classList.remove("hidden");
      $("#resizePreviewWrap").classList.remove("hidden");
      els.exportButton.disabled = false; els.compiledExportButton.disabled = false;
      els.rawZipExportButton.disabled = false; els.compiledZipExportButton.disabled = false; els.resetButton.disabled = false;
      syncInputs(); renderAll(true);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      if (loadId === state.loadId) {
        state.loading = false;
        showToast("图片读取失败，请换一张图片重试。");
      }
    };
    image.src = url;
  }

  async function getCurrentExportBlobs() {
    if (state.loading) {
      showToast("图片正在加载，请稍候。");
      return null;
    }
    if (!state.image) {
      showToast("请先将 PNG、JPG 或 WebP 拖入编辑画布。");
      return null;
    }
    const rawBlob = await canvasToBlob(createRawNinePatchCanvas());
    const compiledBlob = await makeCompiledNinePatch();
    if (!rawBlob || !compiledBlob) throw new Error("Unable to encode current PNG exports");
    return { rawBlob, compiledBlob };
  }

  async function exportNinePatch() {
    try {
      const blobs = await getCurrentExportBlobs();
      if (!blobs) return;
      const baseName = getSafeBaseName();
      downloadBlob(blobs.rawBlob, `${baseName}-raw.9.png`);
      showToast(`已导出 ${baseName}-raw.9.png；外围 1px 黑线是 Android 标记格式要求。`);
    } catch (error) {
      console.error("Raw PNG export failed", error);
      showToast("原始 .9 图导出失败，请重试。");
    }
  }

  function concatBytes(...parts) {
    const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  }

  function writeUint16LE(view, offset, value) {
    view.setUint16(offset, value & 0xffff, true);
  }

  function writeUint32LE(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }

  function makeZip(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    for (const file of files) {
      const name = encoder.encode(file.name);
      const data = new Uint8Array(file.blob instanceof Blob ? file.blob.size : file.blob.length);
      if (file.blob instanceof Blob) {
        throw new Error("ZIP entries must be byte arrays");
      }
      data.set(file.blob);
      const crc = crc32(data);
      const localHeader = new Uint8Array(30);
      const localView = new DataView(localHeader.buffer);
      writeUint32LE(localView, 0, 0x04034b50);
      writeUint16LE(localView, 4, 20);
      writeUint16LE(localView, 6, 0x800);
      writeUint16LE(localView, 8, 0);
      writeUint16LE(localView, 10, dosTime);
      writeUint16LE(localView, 12, dosDate);
      writeUint32LE(localView, 14, crc);
      writeUint32LE(localView, 18, data.length);
      writeUint32LE(localView, 22, data.length);
      writeUint16LE(localView, 26, name.length);
      const local = concatBytes(localHeader, name, data);
      localParts.push(local);

      const centralHeader = new Uint8Array(46);
      const centralView = new DataView(centralHeader.buffer);
      writeUint32LE(centralView, 0, 0x02014b50);
      writeUint16LE(centralView, 4, 20);
      writeUint16LE(centralView, 6, 20);
      writeUint16LE(centralView, 8, 0x800);
      writeUint16LE(centralView, 10, 0);
      writeUint16LE(centralView, 12, dosTime);
      writeUint16LE(centralView, 14, dosDate);
      writeUint32LE(centralView, 16, crc);
      writeUint32LE(centralView, 20, data.length);
      writeUint32LE(centralView, 24, data.length);
      writeUint16LE(centralView, 28, name.length);
      writeUint32LE(centralView, 42, localOffset);
      centralParts.push(concatBytes(centralHeader, name));
      localOffset += local.length;
    }

    const centralDirectory = concatBytes(...centralParts);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    writeUint32LE(endView, 0, 0x06054b50);
    writeUint16LE(endView, 8, files.length);
    writeUint16LE(endView, 10, files.length);
    writeUint32LE(endView, 12, centralDirectory.length);
    writeUint32LE(endView, 16, localOffset);
    return new Blob([concatBytes(...localParts, centralDirectory, end)], { type: "application/zip" });
  }

  async function exportRawZip() {
    try {
      const blobs = await getCurrentExportBlobs();
      if (!blobs) return;
      const baseName = getSafeBaseName();
      const entries = [{ name: `${baseName}-raw.9.png`, blob: new Uint8Array(await blobs.rawBlob.arrayBuffer()) }];
      downloadBlob(makeZip(entries), `${baseName}-raw.zip`);
      showToast(`已导出 ${baseName}-raw.zip，仅包含 ${baseName}-raw.9.png。`);
    } catch (error) {
      console.error("Raw ZIP export failed", error);
      showToast("原始 ZIP 导出失败，请重试。");
    }
  }

  async function exportCompiledZip() {
    try {
      const blobs = await getCurrentExportBlobs();
      if (!blobs) return;
      const baseName = getSafeBaseName();
      const entries = [{ name: `${baseName}-compiled.9.png`, blob: new Uint8Array(await blobs.compiledBlob.arrayBuffer()) }];
      downloadBlob(makeZip(entries), `${baseName}-compiled.zip`);
      showToast(`已导出 ${baseName}-compiled.zip，仅包含 ${baseName}-compiled.9.png。`);
    } catch (error) {
      console.error("Compiled ZIP export failed", error);
      showToast("编译 ZIP 导出失败，请重试。");
    }
  }

  let drag = null;
  let editorResizePending = false;
  els.canvasOverlay.addEventListener("pointerdown", (event) => {
    const target = event.target.dataset.edge;
    if (!target) return;
    event.preventDefault();
    event.target.setPointerCapture?.(event.pointerId);
    drag = {
      target: event.target,
      pointerId: event.pointerId,
      edge: normalizedEdge(target),
      mode: target.indexOf("content") === 0 ? "content" : "stretch"
    };
    event.target.classList.add("is-dragging");
    updateDrag(event);
  });
  window.addEventListener("pointermove", (event) => {
    updateDrag(event);
  });
  const finishEditorDrag = () => {
    if (!drag) return;
    drag.target.classList.remove("is-dragging");
    if (drag.target.hasPointerCapture?.(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
    drag = null;
    els.dragReadout.classList.remove("visible");
    if (editorResizePending) {
      editorResizePending = false;
      renderCanvas(true);
    }
  };
  window.addEventListener("pointerup", finishEditorDrag);
  window.addEventListener("pointercancel", finishEditorDrag);

  els.resetButton.addEventListener("click", resetMarkers);
  els.exportButton.addEventListener("click", exportNinePatch);
  els.compiledExportButton.addEventListener("click", exportCompiledNinePatch);
  els.rawZipExportButton.addEventListener("click", exportRawZip);
  els.compiledZipExportButton.addEventListener("click", exportCompiledZip);
  els.previewTextToggle.addEventListener("change", renderEffectPreview);
  els.helpButton.addEventListener("click", () => els.helpDialog.showModal());
  [els.helpCloseButton, els.helpDoneButton].forEach((button) => {
    button.addEventListener("click", () => els.helpDialog.close());
  });
  els.helpDialog.addEventListener("click", (event) => {
    if (event.target === els.helpDialog) els.helpDialog.close();
  });
  ["left", "right", "top", "bottom"].forEach((edge) => inputs[edge].addEventListener("change", (event) => setEdge(edge, event.target.value)));
  document.querySelectorAll(".mode-button").forEach((button) => button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    document.querySelectorAll(".mode-button").forEach((item) => { item.classList.toggle("active", item === button); item.setAttribute("aria-selected", item === button ? "true" : "false"); });
    updateGuideLayer(); syncInputs(); positionGuides();
  }));
  const updateZoom = (delta) => { state.zoom = clamp(state.zoom + delta, .5, 2.5); els.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`; renderCanvas(true); };
  els.zoomIn.addEventListener("click", () => updateZoom(.1)); els.zoomOut.addEventListener("click", () => updateZoom(-.1));
  els.zoomReset.addEventListener("click", () => { state.zoom = 1; els.zoomLabel.textContent = "100%"; renderCanvas(true); });
  document.querySelectorAll(".editor-zoom-handle").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      if (!state.image) return;
      event.preventDefault();
      const direction = handle.dataset.zoomDirection;
      const start = { x: event.clientX, y: event.clientY, zoom: state.zoom };
      let moved = false;
      handle.setPointerCapture?.(event.pointerId);
      const move = (moveEvent) => {
        const horizontal = direction.includes("e") ? moveEvent.clientX - start.x : start.x - moveEvent.clientX;
        const vertical = direction.includes("s") ? moveEvent.clientY - start.y : start.y - moveEvent.clientY;
        const delta = (horizontal + vertical) / 260;
        if (Math.abs(delta) > .01) moved = true;
        state.zoom = clamp(start.zoom + delta, .5, 2.5);
        els.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
        renderCanvas(true);
      };
      const cancel = () => stop(true);
      const stop = (cancelled = false) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", cancel);
        if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        if (!cancelled && !moved) updateZoom(.1);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
      window.addEventListener("pointercancel", cancel, { once: true });
    });
  });
  let canvasDragDepth = 0;
  els.canvasStage.addEventListener("dragenter", (event) => {
    event.preventDefault();
    event.stopPropagation();
    canvasDragDepth += 1;
    els.canvasStage.classList.add("is-drop-target");
  });
  els.canvasStage.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    els.canvasStage.classList.add("is-drop-target");
  });
  els.canvasStage.addEventListener("dragleave", (event) => {
    event.preventDefault();
    event.stopPropagation();
    canvasDragDepth = Math.max(0, canvasDragDepth - 1);
    if (!canvasDragDepth) els.canvasStage.classList.remove("is-drop-target");
  });
  els.canvasStage.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    canvasDragDepth = 0;
    els.canvasStage.classList.remove("is-drop-target");
    loadFile(event.dataTransfer?.files?.[0]);
  });
  const handleEditorResize = () => {
    if (!state.image) return;
    if (drag) {
      editorResizePending = true;
      return;
    }
    renderCanvas(true);
    renderEffectPreview();
  };
  window.addEventListener("resize", handleEditorResize);
  if (typeof ResizeObserver !== "undefined") {
    const editorObserver = new ResizeObserver(handleEditorResize);
    editorObserver.observe(els.canvasStage);
  }

  document.querySelectorAll(".resize-handle").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      if (!state.image) return;
      event.preventDefault();
      const direction = handle.dataset.direction;
      const canvas = $("#effectCanvas");
      const displayedWidth = Number(canvas.width) || Number(state.previewSize.width);
      const displayedHeight = Number(canvas.height) || Number(state.previewSize.height);
      const currentWidth = Math.max(1, displayedWidth || state.sourceWidth);
      const currentHeight = Math.max(1, displayedHeight || state.sourceHeight);
      state.previewSize.width = currentWidth;
      state.previewSize.height = currentHeight;
      const start = { x: event.clientX, y: event.clientY, width: currentWidth, height: currentHeight };
      handle.setPointerCapture?.(event.pointerId);
      const move = (moveEvent) => {
        const minWidth = state.stretch.left + state.stretch.right + 1;
        const minHeight = state.stretch.top + state.stretch.bottom + 1;
        const dx = moveEvent.clientX - start.x, dy = moveEvent.clientY - start.y;
        const changeX = direction.includes("e") ? dx : -dx;
        const changeY = direction.includes("s") ? dy : -dy;
        state.previewSize.width = clamp(start.width + changeX, minWidth, Math.max(minWidth, state.sourceWidth * 5));
        state.previewSize.height = clamp(start.height + changeY, minHeight, Math.max(minHeight, state.sourceHeight * 5));
        renderEffectPreview();
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
      window.addEventListener("pointercancel", stop, { once: true });
    });
  });
})();
