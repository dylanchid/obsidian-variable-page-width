import {
  App,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  debounce,
} from "obsidian";

interface VariablePageWidthSettings {
  /** Frontmatter key that stores page width in px for each note. */
  propertyName: string;
  /** Fallback width when a note has no property and user starts dragging. */
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  /** Show drag handles only while hovering the note body. */
  showHandlesOnHover: boolean;
  /** Persist layout values in note frontmatter (per-file). */
  persistInFrontmatter: boolean;
}

interface PageLayout {
  width: number;
  /** Horizontal page offset from the pane center. Positive values move right. */
  offset: number;
  indentLeft: number;
  indentRight: number;
}

const DEFAULT_SETTINGS: VariablePageWidthSettings = {
  propertyName: "page-width",
  defaultWidth: 720,
  minWidth: 320,
  maxWidth: 1600,
  showHandlesOnHover: true,
  persistInFrontmatter: true,
};

const EDGE_GUTTER = 12;
const HANDLE_WIDTH = 14;
const MIN_CONTENT_WIDTH = 120;

type DragSide = "left" | "right";
type DragMode = "width" | "margin" | "indent";

interface LeafHandles {
  leaf: WorkspaceLeaf;
  root: HTMLElement;
  left: HTMLElement;
  right: HTMLElement;
  tooltip: HTMLElement;
  cleanup: () => void;
}

interface DragState {
  leaf: WorkspaceLeaf;
  side: DragSide;
  mode: DragMode;
  startX: number;
  startLayout: PageLayout;
  viewWidth: number;
  liveLayout: PageLayout;
}

export default class VariablePageWidthPlugin extends Plugin {
  settings: VariablePageWidthSettings = DEFAULT_SETTINGS;
  private handlesByLeaf = new Map<WorkspaceLeaf, LeafHandles>();
  private layoutByPath = new Map<string, PageLayout | null>();
  private drag: DragState | null = null;
  private hover: {
    leaf: WorkspaceLeaf;
    side: DragSide;
    clientY: number;
  } | null = null;
  private saveQueue = new Map<string, PageLayout>();

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new VariablePageWidthSettingTab(this.app, this));

    this.addCommand({
      id: "reset-page-width",
      name: "Reset page width, margins, and indents for this note",
      checkCallback: (checking) => {
        const view = this.getActiveMarkdownView();
        if (!view?.file) return false;
        if (!checking) void this.resetWidth(view);
        return true;
      },
    });

    this.addCommand({
      id: "set-page-width",
      name: "Set page width for this note…",
      checkCallback: (checking) => {
        const view = this.getActiveMarkdownView();
        if (!view?.file) return false;
        if (!checking) {
          const current =
            this.getLayoutForFile(view.file)?.width ?? this.settings.defaultWidth;
          const raw = window.prompt(
            `Page width in px (${this.settings.minWidth}–${this.settings.maxWidth})`,
            String(current),
          );
          if (raw == null) return;
          const n = Number(raw);
          if (!Number.isFinite(n)) {
            new Notice("Invalid width");
            return;
          }

          const currentLayout = this.getLayoutForFile(view.file) ?? {
            width: this.settings.defaultWidth,
            offset: 0,
            indentLeft: 0,
            indentRight: 0,
          };
          void this.applyAndPersist(view, {
            ...currentLayout,
            width: this.clampWidth(n),
          });
        }
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.refreshAllLeaves()),
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.refreshAllLeaves()),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.refreshAllLeaves()),
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (!(file instanceof TFile)) return;
        this.invalidateCache(file.path);
        this.refreshLeavesForPath(file.path);
      }),
    );

    this.registerDomEvent(window, "mousemove", (e) => this.onPointerMove(e));
    this.registerDomEvent(window, "mouseup", () => this.onPointerUp());
    this.registerDomEvent(window, "keydown", (e) => this.onModifierChange(e));
    this.registerDomEvent(window, "keyup", (e) => this.onModifierChange(e));
    this.registerDomEvent(window, "blur", () => this.cancelInteractionState());
    this.registerDomEvent(window, "resize", () => this.repositionAllHandles());

    this.app.workspace.onLayoutReady(() => this.refreshAllLeaves());
  }

  onunload() {
    this.cancelInteractionState();
    for (const handles of this.handlesByLeaf.values()) handles.cleanup();
    this.handlesByLeaf.clear();
    this.app.workspace.iterateAllLeaves((leaf) => this.clearLeafStyles(leaf));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.layoutByPath.clear();
    this.refreshAllLeaves();
  }

  private getActiveMarkdownView(): MarkdownView | null {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }

  private clampWidth(n: number): number {
    return Math.round(
      Math.min(this.settings.maxWidth, Math.max(this.settings.minWidth, n)),
    );
  }

  private propertyNames() {
    const width = this.settings.propertyName;
    return {
      width,
      offset: `${width}-offset`,
      indentLeft: `${width}-indent-left`,
      indentRight: `${width}-indent-right`,
    };
  }

  private parsePixels(raw: unknown, fallback = 0): number {
    if (raw == null || raw === "") return fallback;
    const parsed =
      typeof raw === "number"
        ? raw
        : Number(String(raw).replace(/px$/i, "").trim());
    return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
  }

  private normaliseLayout(layout: PageLayout): PageLayout {
    const width = this.clampWidth(layout.width);
    const indentLeft = Math.max(0, Math.round(layout.indentLeft));
    const indentRight = Math.max(0, Math.round(layout.indentRight));
    const maxIndent = Math.max(0, width - MIN_CONTENT_WIDTH);
    const indentTotal = indentLeft + indentRight;
    const scale = indentTotal > maxIndent && indentTotal > 0 ? maxIndent / indentTotal : 1;

    return {
      width,
      offset: Math.round(layout.offset),
      indentLeft: Math.round(indentLeft * scale),
      indentRight: Math.round(indentRight * scale),
    };
  }

  private invalidateCache(path: string) {
    this.layoutByPath.delete(path);
  }

  /** Read the per-note layout. null means the note has no width override. */
  private getLayoutForFile(file: TFile): PageLayout | null {
    if (this.layoutByPath.has(file.path)) {
      return this.layoutByPath.get(file.path) ?? null;
    }

    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const names = this.propertyNames();
    const rawWidth = fm?.[names.width];
    if (rawWidth == null || rawWidth === "") {
      this.layoutByPath.set(file.path, null);
      return null;
    }

    const parsedWidth = this.parsePixels(rawWidth, Number.NaN);
    if (!Number.isFinite(parsedWidth)) {
      this.layoutByPath.set(file.path, null);
      return null;
    }

    const layout = this.normaliseLayout({
      width: parsedWidth,
      offset: this.parsePixels(fm?.[names.offset]),
      indentLeft: this.parsePixels(fm?.[names.indentLeft]),
      indentRight: this.parsePixels(fm?.[names.indentRight]),
    });
    this.layoutByPath.set(file.path, layout);
    return layout;
  }

  private refreshAllLeaves() {
    const seen = new Set<WorkspaceLeaf>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      seen.add(leaf);
      this.syncLeaf(leaf);
    });

    for (const leaf of [...this.handlesByLeaf.keys()]) {
      if (!seen.has(leaf)) {
        this.handlesByLeaf.get(leaf)?.cleanup();
        this.handlesByLeaf.delete(leaf);
      }
    }
  }

  private refreshLeavesForPath(path: string) {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path) {
        this.syncLeaf(leaf);
      }
    });
  }

  private syncLeaf(leaf: WorkspaceLeaf) {
    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.file) {
      this.teardownHandles(leaf);
      this.clearLeafStyles(leaf);
      return;
    }

    const layout = this.getLayoutForFile(view.file);
    if (layout) this.applyLayoutToLeaf(leaf, layout);
    else this.clearLeafStyles(leaf);

    this.ensureHandles(leaf, view);
    this.repositionHandles(leaf);
  }

  private fitLayoutToView(layout: PageLayout, viewWidth: number): PageLayout {
    const available = Math.max(MIN_CONTENT_WIDTH, Math.floor(viewWidth - EDGE_GUTTER * 2));
    const normalised = this.normaliseLayout(layout);
    const width = Math.min(normalised.width, available);
    const maxOffset = Math.max(0, (viewWidth - width) / 2 - EDGE_GUTTER);
    const maxIndent = Math.max(0, width - MIN_CONTENT_WIDTH);
    const indentTotal = normalised.indentLeft + normalised.indentRight;
    const indentScale = indentTotal > maxIndent && indentTotal > 0
      ? maxIndent / indentTotal
      : 1;
    return {
      width,
      offset: Math.round(
        Math.min(maxOffset, Math.max(-maxOffset, normalised.offset)),
      ),
      indentLeft: Math.round(normalised.indentLeft * indentScale),
      indentRight: Math.round(normalised.indentRight * indentScale),
    };
  }

  private applyLayoutToLeaf(leaf: WorkspaceLeaf, layout: PageLayout) {
    const leafEl = this.getLeafContainer(leaf);
    const hostWidth = leaf.view instanceof MarkdownView
      ? leaf.view.contentEl.getBoundingClientRect().width
      : leafEl.getBoundingClientRect().width;
    const fitted = this.fitLayoutToView(layout, hostWidth || layout.width + EDGE_GUTTER * 2);
    const renderedWidth = Math.max(
      MIN_CONTENT_WIDTH,
      fitted.width - fitted.indentLeft - fitted.indentRight,
    );
    const renderedOffset =
      fitted.offset + (fitted.indentLeft - fitted.indentRight) / 2;

    const el = leafEl;
    el.classList.add("vpw-enabled");
    el.style.setProperty("--vpw-width", `${renderedWidth}px`);
    el.style.setProperty("--vpw-offset", `${renderedOffset}px`);
    el.style.setProperty("--file-line-width", `${renderedWidth}px`);
  }

  private clearLeafStyles(leaf: WorkspaceLeaf) {
    const el = this.getLeafContainer(leaf);
    el.classList.remove("vpw-enabled");
    el.style.removeProperty("--vpw-width");
    el.style.removeProperty("--vpw-offset");
    if (el.style.getPropertyValue("--file-line-width")) {
      el.style.removeProperty("--file-line-width");
    }
  }

  private getLeafContainer(leaf: WorkspaceLeaf): HTMLElement {
    return (leaf as WorkspaceLeaf & { containerEl: HTMLElement }).containerEl;
  }

  private modeFromModifiers(metaKey: boolean, shiftKey: boolean): DragMode {
    if (metaKey && shiftKey) return "indent";
    if (metaKey) return "margin";
    return "width";
  }

  private tooltipText(side: DragSide, mode: DragMode): string {
    if (mode === "margin") return `Adjust ${side} margin`;
    if (mode === "indent") return `Adjust ${side} indent`;
    return "Resize page width  ·  ⌘ margin  ·  ⇧⌘ indent";
  }

  private updateHandleMode(handles: LeafHandles, side: DragSide, mode: DragMode) {
    const active = side === "left" ? handles.left : handles.right;
    handles.left.removeAttribute("data-mode");
    handles.right.removeAttribute("data-mode");
    active.dataset.mode = mode;
    active.setAttribute("aria-label", this.tooltipText(side, mode));
    handles.tooltip.textContent = this.tooltipText(side, mode);
  }

  private positionTooltip(handles: LeafHandles, side: DragSide, clientY: number) {
    const host = (handles.leaf.view as MarkdownView).contentEl;
    const hostRect = host.getBoundingClientRect();
    const handle = side === "left" ? handles.left : handles.right;
    const handleLeft = Number.parseFloat(handle.style.left) || 0;
    const tooltipHalfWidth = Math.min(140, hostRect.width / 2);
    const tooltipCenter = Math.min(
      hostRect.width - tooltipHalfWidth,
      Math.max(tooltipHalfWidth, handleLeft + HANDLE_WIDTH / 2),
    );
    handles.tooltip.style.left = `${tooltipCenter}px`;
    const tooltipTop = Math.min(
      Math.max(10, hostRect.height - 36),
      Math.max(10, clientY - hostRect.top + 16),
    );
    handles.tooltip.style.top = `${tooltipTop}px`;
    handles.tooltip.classList.add("is-visible");
  }

  private ensureHandles(leaf: WorkspaceLeaf, view: MarkdownView) {
    if (this.handlesByLeaf.has(leaf)) return;

    const host = view.contentEl;
    host.style.position = host.style.position || "relative";

    const root = host.createDiv({ cls: "vpw-handles" });
    if (this.settings.showHandlesOnHover) root.classList.add("vpw-hover-mode");

    const left = root.createDiv({
      cls: "vpw-handle vpw-handle-left",
      attr: { "aria-label": "Drag to resize page width", role: "separator" },
    });
    const right = root.createDiv({
      cls: "vpw-handle vpw-handle-right",
      attr: { "aria-label": "Drag to resize page width", role: "separator" },
    });
    const tooltip = root.createDiv({ cls: "vpw-tooltip" });
    const handles: LeafHandles = {
      leaf,
      root,
      left,
      right,
      tooltip,
      cleanup: () => undefined,
    };

    const beginDrag = (side: DragSide, e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const file = view.file;
      if (!file) return;

      const viewWidth = host.getBoundingClientRect().width;
      const current = this.getLayoutForFile(file) ?? {
        width:
          this.measureCurrentContentWidth(view) ?? this.settings.defaultWidth,
        offset: 0,
        indentLeft: 0,
        indentRight: 0,
      };
      const startLayout = this.fitLayoutToView(current, viewWidth);
      const mode = this.modeFromModifiers(e.metaKey, e.shiftKey);

      this.applyLayoutToLeaf(leaf, startLayout);
      this.drag = {
        leaf,
        side,
        mode,
        startX: e.clientX,
        startLayout,
        viewWidth,
        liveLayout: { ...startLayout },
      };
      this.updateHandleMode(handles, side, mode);
      this.positionTooltip(handles, side, e.clientY);
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
    };

    const enterHandle = (side: DragSide, e: MouseEvent) => {
      this.hover = { leaf, side, clientY: e.clientY };
      const mode = this.modeFromModifiers(e.metaKey, e.shiftKey);
      this.updateHandleMode(handles, side, mode);
      this.positionTooltip(handles, side, e.clientY);
    };
    const moveHandle = (side: DragSide, e: MouseEvent) => {
      if (this.drag) return;
      this.hover = { leaf, side, clientY: e.clientY };
      this.updateHandleMode(
        handles,
        side,
        this.modeFromModifiers(e.metaKey, e.shiftKey),
      );
      this.positionTooltip(handles, side, e.clientY);
    };
    const leaveHandle = () => {
      if (this.drag) return;
      this.hover = null;
      left.removeAttribute("data-mode");
      right.removeAttribute("data-mode");
      tooltip.classList.remove("is-visible");
    };
    const onDblClick = () => void this.resetWidth(view);

    const onLeftDown = (e: MouseEvent) => beginDrag("left", e);
    const onRightDown = (e: MouseEvent) => beginDrag("right", e);
    const onLeftEnter = (e: MouseEvent) => enterHandle("left", e);
    const onRightEnter = (e: MouseEvent) => enterHandle("right", e);
    const onLeftMove = (e: MouseEvent) => moveHandle("left", e);
    const onRightMove = (e: MouseEvent) => moveHandle("right", e);

    left.addEventListener("mousedown", onLeftDown);
    right.addEventListener("mousedown", onRightDown);
    left.addEventListener("mouseenter", onLeftEnter);
    right.addEventListener("mouseenter", onRightEnter);
    left.addEventListener("mousemove", onLeftMove);
    right.addEventListener("mousemove", onRightMove);
    left.addEventListener("mouseleave", leaveHandle);
    right.addEventListener("mouseleave", leaveHandle);
    left.addEventListener("dblclick", onDblClick);
    right.addEventListener("dblclick", onDblClick);

    const cleanup = () => {
      left.removeEventListener("mousedown", onLeftDown);
      right.removeEventListener("mousedown", onRightDown);
      left.removeEventListener("mouseenter", onLeftEnter);
      right.removeEventListener("mouseenter", onRightEnter);
      left.removeEventListener("mousemove", onLeftMove);
      right.removeEventListener("mousemove", onRightMove);
      left.removeEventListener("mouseleave", leaveHandle);
      right.removeEventListener("mouseleave", leaveHandle);
      left.removeEventListener("dblclick", onDblClick);
      right.removeEventListener("dblclick", onDblClick);
      root.remove();
    };

    handles.cleanup = cleanup;
    this.handlesByLeaf.set(leaf, handles);
  }

  private teardownHandles(leaf: WorkspaceLeaf) {
    const handles = this.handlesByLeaf.get(leaf);
    if (!handles) return;
    handles.cleanup();
    this.handlesByLeaf.delete(leaf);
    if (this.hover?.leaf === leaf) this.hover = null;
  }

  private measureCurrentContentWidth(view: MarkdownView): number | null {
    const sizer = view.contentEl.querySelector(
      ".cm-sizer, .markdown-preview-sizer, .cm-content",
    ) as HTMLElement | null;
    if (!sizer) return null;
    const width = sizer.getBoundingClientRect().width;
    return width > 0 ? Math.round(width) : null;
  }

  private displayLayout(view: MarkdownView, hostWidth: number): PageLayout {
    const stored = view.file ? this.getLayoutForFile(view.file) : null;
    const layout = stored ?? {
      width:
        this.measureCurrentContentWidth(view) ??
        Math.min(hostWidth - EDGE_GUTTER * 2, this.settings.defaultWidth),
      offset: 0,
      indentLeft: 0,
      indentRight: 0,
    };
    return this.fitLayoutToView(layout, hostWidth);
  }

  private repositionAllHandles() {
    for (const leaf of this.handlesByLeaf.keys()) this.repositionHandles(leaf);
  }

  private repositionHandles(leaf: WorkspaceLeaf) {
    const handles = this.handlesByLeaf.get(leaf);
    const view = leaf.view;
    if (!handles || !(view instanceof MarkdownView)) return;

    const hostRect = view.contentEl.getBoundingClientRect();
    if (hostRect.width <= 0) return;

    const layout = this.drag?.leaf === leaf
      ? this.drag.liveLayout
      : this.displayLayout(view, hostRect.width);
    const center = hostRect.width / 2 + layout.offset;
    const leftEdge = center - layout.width / 2;
    const rightEdge = center + layout.width / 2;

    handles.left.style.left = `${Math.max(0, leftEdge - HANDLE_WIDTH / 2)}px`;
    handles.right.style.left = `${Math.min(
      hostRect.width - HANDLE_WIDTH,
      rightEdge - HANDLE_WIDTH / 2,
    )}px`;
  }

  private onModifierChange(e: KeyboardEvent) {
    if (!this.hover || this.drag) return;
    const handles = this.handlesByLeaf.get(this.hover.leaf);
    if (!handles) return;
    this.updateHandleMode(
      handles,
      this.hover.side,
      this.modeFromModifiers(e.metaKey, e.shiftKey),
    );
    this.positionTooltip(handles, this.hover.side, this.hover.clientY);
  }

  private nextDragLayout(e: MouseEvent): PageLayout {
    const drag = this.drag!;
    const { side, mode, startX, startLayout, viewWidth } = drag;
    const dx = e.clientX - startX;

    if (mode === "indent") {
      const next = { ...startLayout };
      if (side === "left") {
        next.indentLeft = Math.min(
          Math.max(0, startLayout.indentLeft + dx),
          startLayout.width - startLayout.indentRight - MIN_CONTENT_WIDTH,
        );
      } else {
        next.indentRight = Math.min(
          Math.max(0, startLayout.indentRight - dx),
          startLayout.width - startLayout.indentLeft - MIN_CONTENT_WIDTH,
        );
      }
      return this.fitLayoutToView(next, viewWidth);
    }

    if (mode === "margin") {
      const startCenter = viewWidth / 2 + startLayout.offset;
      const startLeft = startCenter - startLayout.width / 2;
      const startRight = startCenter + startLayout.width / 2;
      const maximumPaneWidth = Math.max(
        MIN_CONTENT_WIDTH,
        viewWidth - EDGE_GUTTER * 2,
      );
      const minimumWidth = Math.min(
        maximumPaneWidth,
        Math.max(
          Math.min(this.settings.minWidth, maximumPaneWidth),
          startLayout.indentLeft + startLayout.indentRight + MIN_CONTENT_WIDTH,
        ),
      );
      let left = startLeft;
      let right = startRight;

      if (side === "left") {
        left = Math.max(
          EDGE_GUTTER,
          Math.min(startLeft + dx, startRight - minimumWidth),
          startRight - this.settings.maxWidth,
        );
      } else {
        right = Math.min(
          viewWidth - EDGE_GUTTER,
          Math.max(startRight + dx, startLeft + minimumWidth),
          startLeft + this.settings.maxWidth,
        );
      }

      return this.fitLayoutToView({
        ...startLayout,
        width: right - left,
        offset: (left + right) / 2 - viewWidth / 2,
      }, viewWidth);
    }

    const delta = side === "left" ? -dx * 2 : dx * 2;
    const maximumPaneWidth = Math.max(
      MIN_CONTENT_WIDTH,
      viewWidth - EDGE_GUTTER * 2,
    );
    const minimumWidth = Math.min(
      maximumPaneWidth,
      Math.max(
        Math.min(this.settings.minWidth, maximumPaneWidth),
        startLayout.indentLeft + startLayout.indentRight + MIN_CONTENT_WIDTH,
      ),
    );
    const maxWidthInPane = Math.max(
      minimumWidth,
      viewWidth - EDGE_GUTTER * 2 - Math.abs(startLayout.offset) * 2,
    );
    const width = Math.min(
      this.settings.maxWidth,
      maxWidthInPane,
      Math.max(minimumWidth, startLayout.width + delta),
    );
    return this.fitLayoutToView({ ...startLayout, width }, viewWidth);
  }

  private updateDragTooltip(drag: DragState) {
    const handles = this.handlesByLeaf.get(drag.leaf);
    if (!handles) return;
    let value: number;
    if (drag.mode === "indent") {
      value = drag.side === "left"
        ? drag.liveLayout.indentLeft
        : drag.liveLayout.indentRight;
    } else if (drag.mode === "margin") {
      const center = drag.viewWidth / 2 + drag.liveLayout.offset;
      value = drag.side === "left"
        ? center - drag.liveLayout.width / 2
        : drag.viewWidth - (center + drag.liveLayout.width / 2);
    } else {
      value = drag.liveLayout.width;
    }
    const label = drag.mode === "width"
      ? "Page width"
      : `${drag.side[0].toUpperCase()}${drag.side.slice(1)} ${drag.mode}`;
    handles.tooltip.textContent = `${label}: ${Math.round(value)} px`;
  }

  private onPointerMove(e: MouseEvent) {
    if (!this.drag) return;

    const next = this.nextDragLayout(e);
    this.drag.liveLayout = next;
    this.applyLayoutToLeaf(this.drag.leaf, next);
    this.repositionHandles(this.drag.leaf);
    this.updateDragTooltip(this.drag);
  }

  private onPointerUp() {
    if (!this.drag) return;

    const { leaf, liveLayout } = this.drag;
    this.drag = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";

    const handles = this.handlesByLeaf.get(leaf);
    handles?.tooltip.classList.remove("is-visible");
    handles?.left.removeAttribute("data-mode");
    handles?.right.removeAttribute("data-mode");
    this.hover = null;

    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.file) return;
    void this.applyAndPersist(view, liveLayout);
  }

  private cancelInteractionState() {
    this.drag = null;
    this.hover = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    for (const handles of this.handlesByLeaf.values()) {
      handles.tooltip.classList.remove("is-visible");
      handles.left.removeAttribute("data-mode");
      handles.right.removeAttribute("data-mode");
    }
  }

  private async applyAndPersist(view: MarkdownView, layout: PageLayout) {
    const file = view.file;
    if (!file) return;

    const normalised = this.normaliseLayout(layout);
    this.layoutByPath.set(file.path, normalised);
    this.applyLayoutToLeaf(view.leaf, normalised);
    this.repositionHandles(view.leaf);

    if (!this.settings.persistInFrontmatter) return;
    this.saveQueue.set(file.path, { ...normalised });
    this.debouncedFlushSaves();
  }

  private debouncedFlushSaves = debounce(() => void this.flushSaves(), 400, true);

  private async flushSaves() {
    const entries = [...this.saveQueue.entries()];
    this.saveQueue.clear();
    const names = this.propertyNames();

    for (const [path, layout] of entries) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      try {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          fm[names.width] = layout.width;
          this.writeOptionalValue(fm, names.offset, layout.offset);
          this.writeOptionalValue(fm, names.indentLeft, layout.indentLeft);
          this.writeOptionalValue(fm, names.indentRight, layout.indentRight);
        });
      } catch (err) {
        console.error("Variable Page Width: failed to save frontmatter", err);
        new Notice("Could not save page layout to note");
      }
    }
  }

  private writeOptionalValue(
    frontmatter: Record<string, unknown>,
    property: string,
    value: number,
  ) {
    if (value === 0) delete frontmatter[property];
    else frontmatter[property] = Math.round(value);
  }

  async resetWidth(view: MarkdownView) {
    const file = view.file;
    if (!file) return;

    this.layoutByPath.delete(file.path);
    this.saveQueue.delete(file.path);
    this.clearLeafStyles(view.leaf);
    this.repositionHandles(view.leaf);

    if (this.settings.persistInFrontmatter) {
      const names = this.propertyNames();
      try {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          delete fm[names.width];
          delete fm[names.offset];
          delete fm[names.indentLeft];
          delete fm[names.indentRight];
        });
        new Notice("Page width, margins, and indents reset for this note");
      } catch (err) {
        console.error(err);
        new Notice("Could not clear page layout properties");
      }
    }
  }
}

class VariablePageWidthSettingTab extends PluginSettingTab {
  plugin: VariablePageWidthPlugin;

  constructor(app: App, plugin: VariablePageWidthPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Variable Page Width" });
    containerEl.createEl("p", {
      text: "Drag either page edge to resize symmetrically. Hold Command while dragging to move only that margin, or Command–Shift to adjust that side's indent.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Frontmatter property")
      .setDesc(
        "Base property name. Offset and indent values use related properties such as page-width-offset and page-width-indent-left.",
      )
      .addText((text) =>
        text
          .setPlaceholder("page-width")
          .setValue(this.plugin.settings.propertyName)
          .onChange(async (value) => {
            this.plugin.settings.propertyName = value.trim() || "page-width";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Persist in frontmatter")
      .setDesc(
        "When on, width, margin offset, and indents are saved on the individual note. When off, they last only for the session.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.persistInFrontmatter)
          .onChange(async (value) => {
            this.plugin.settings.persistInFrontmatter = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Default width")
      .setDesc("Starting width (px) when you first drag a note with no saved layout.")
      .addSlider((slider) =>
        slider
          .setLimits(320, 1400, 10)
          .setValue(this.plugin.settings.defaultWidth)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.defaultWidth = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Minimum width")
      .addSlider((slider) =>
        slider
          .setLimits(200, 800, 10)
          .setValue(this.plugin.settings.minWidth)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.minWidth = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Maximum width")
      .addSlider((slider) =>
        slider
          .setLimits(600, 2400, 20)
          .setValue(this.plugin.settings.maxWidth)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxWidth = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}
