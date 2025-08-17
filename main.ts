import { App, Plugin, ItemView, WorkspaceLeaf, TFile, MarkdownView, PluginSettingTab, Setting, setIcon } from "obsidian";

const VIEW_TYPE_TODO_TREE = "todo-tree-view";
const DEBOUNCE_DELAY = 300; // ms
const HIGHLIGHT_DURATION = 200; // ms
const CSS_HIGHLIGHT_DURATION = 2000; // ms

interface TodoItem {
	text: string;
	line: number;
}

interface TodoTreeSettings {
	searchStrings: string[];
}

interface FileTree {
	name: string;
	children: Record<string, FileTree>;
	isFile: boolean;
	path: string;
	hasTodos: boolean;
	todoCount: number;
}

const DEFAULT_SETTINGS: TodoTreeSettings = {
	searchStrings: ["todo", "fixme", "should remember to"],
}

export default class TodoTreePlugin extends Plugin {
	settings: TodoTreeSettings;
	refreshTimeout: NodeJS.Timeout | null = null;

	async onload() {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE_TODO_TREE,
			(leaf) => new TodoTreeView(leaf, this.app, this.settings)
		);

		this.addRibbonIcon("check-square", "Open TODO Tree", () => {
			this.activateView();
		});

		this.addCommand({
			id: "open-todo-tree",
			name: "Open TODO Tree",
			callback: () => this.activateView(),
		});

		this.addSettingTab(new TodoTreeSettingTab(this.app, this));

		// Listen for file modifications to update the TODO tree
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				this.refreshTodoViews();
			})
		);

		// Listen for file creation
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				this.refreshTodoViews();
			})
		);

		// Listen for file deletion
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.refreshTodoViews();
			})
		);

		// Listen for file rename
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.refreshTodoViews();
			})
		);
	}

	onunload() {
		if (this.refreshTimeout) {
			clearTimeout(this.refreshTimeout);
			this.refreshTimeout = null;
		}
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_TODO_TREE);
	}

	async activateView() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_TODO_TREE);

		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({
				type: VIEW_TYPE_TODO_TREE,
				active: true,
			});
			this.app.workspace.revealLeaf(
				this.app.workspace.getLeavesOfType(VIEW_TYPE_TODO_TREE)[0]
			);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private refreshTodoViews(): void {
		// Debounce the refresh to avoid excessive updates
		if (this.refreshTimeout) {
			clearTimeout(this.refreshTimeout);
		}

		this.refreshTimeout = setTimeout(() => {
			const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TODO_TREE);
			for (const leaf of leaves) {
				const view = leaf.view as TodoTreeView;
				view.refresh();
			}
			this.refreshTimeout = null;
		}, DEBOUNCE_DELAY);
	}
}

class TodoTreeSettingTab extends PluginSettingTab {
	plugin: TodoTreePlugin;

	constructor(app: App, plugin: TodoTreePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Search strings")
			.setDesc("One per line. These are case-insensitive.")
			.addTextArea(text => text
				.setValue(this.plugin.settings.searchStrings.join("\n"))
				.onChange(async (value) => {
					this.plugin.settings.searchStrings = value.split("\n").map(s => s.trim()).filter(s => s.length > 0);
					await this.plugin.saveSettings();
				}));
	}
}

class TodoTreeView extends ItemView {
	app: App;
	private todos: Record<string, TodoItem[]> = {};
	private readonly settings: TodoTreeSettings;
	private readonly expandedFolders: Set<string> = new Set();

	constructor(leaf: WorkspaceLeaf, app: App, settings: TodoTreeSettings) {
		super(leaf);
		this.app = app;
		this.settings = settings;
	}

	getViewType() {
		return VIEW_TYPE_TODO_TREE;
	}

	getDisplayText() {
		return "TODO Tree";
	}

	async onOpen() {
		this.todos = await this.scanTodos();
		this.render();
	}

	public async refresh(): Promise<void> {
		this.captureExpansionState();
		this.todos = await this.scanTodos();
		this.render();
	}

	private captureExpansionState(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		const details = container.findAll("details");
		this.expandedFolders.clear();

		details.forEach((detail) => {
			const detailEl = detail as HTMLDetailsElement;
			if (detailEl.open) {
				// Use the folder path as identifier - get it from the summary text and calculate path
				const summary = detailEl.querySelector("summary");
				if (summary) {
					const folderName = summary.textContent?.trim();
					if (folderName) {
						// Calculate the folder path based on nesting level
						const folderPath = this.calculateFolderPath(detailEl);
						this.expandedFolders.add(folderPath);
					}
				}
			}
		});
	}

	private calculateFolderPath(detailEl: HTMLDetailsElement): string {
		// Use the stored data attribute instead of parsing text content
		return detailEl.getAttribute("data-folder-path") || "";
	} private highlightTodoLine(editor: any, lineNumber: number, todoText: string): void {
		// Position cursor at the beginning of the line
		editor.setCursor({ line: lineNumber, ch: 0 });

		// Use temporary selection for visual feedback
		const lineContent = editor.getLine(lineNumber);
		const todoTextTrimmed = todoText.trim();
		const lineIndex = lineContent.toLowerCase().indexOf(todoTextTrimmed.toLowerCase());

		if (lineIndex !== -1) {
			this.createTextSelection(editor, lineNumber, lineIndex, todoTextTrimmed.length);
		} else {
			this.createLineSelection(editor, lineNumber, lineContent.length);
		}

		this.addCssHighlight(editor, lineNumber);
	}

	private createTextSelection(editor: any, lineNumber: number, startChar: number, length: number): void {
		const startPos = { line: lineNumber, ch: startChar };
		const endPos = { line: lineNumber, ch: startChar + length };

		editor.setSelection(startPos, endPos);
		setTimeout(() => {
			editor.setCursor(startPos);
		}, HIGHLIGHT_DURATION);
	}

	private createLineSelection(editor: any, lineNumber: number, lineLength: number): void {
		const startPos = { line: lineNumber, ch: 0 };
		const endPos = { line: lineNumber, ch: lineLength };

		editor.setSelection(startPos, endPos);
		setTimeout(() => {
			editor.setCursor({ line: lineNumber, ch: 0 });
		}, HIGHLIGHT_DURATION);
	}

	private addCssHighlight(editor: any, lineNumber: number): void {
		try {
			const editorEl = editor.containerEl || editor.dom;
			if (editorEl) {
				const lineElements = editorEl.querySelectorAll('.cm-line, .CodeMirror-line');
				const lineEl = lineElements[lineNumber];
				if (lineEl) {
					lineEl.classList.add('todo-highlight-line');
					setTimeout(() => {
						lineEl.classList.remove('todo-highlight-line');
					}, CSS_HIGHLIGHT_DURATION);
				}
			}
		} catch (e) {
			// Silently handle any CSS highlighting errors
		}
	}

	private async scanTodos(): Promise<Record<string, TodoItem[]>> {
		const todos: Record<string, TodoItem[]> = {};
		const files = this.app.vault.getMarkdownFiles();
		const searchStrings = this.settings.searchStrings.map(s => s.toLowerCase());

		for (const file of files) {
			const content = await this.app.vault.cachedRead(file);
			const lines = content.split("\n");
			const fileTodos: TodoItem[] = [];

			for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
				const line = lines[lineIndex];
				const lowerCaseLine = line.toLowerCase();

				// Check if any search string is found in this line
				const hasMatch = searchStrings.some(searchString =>
					lowerCaseLine.includes(searchString)
				);

				if (hasMatch) {
					fileTodos.push({
						text: line.trim(),
						line: lineIndex
					});
				}
			}

			if (fileTodos.length > 0) {
				todos[file.path] = fileTodos;
			}
		}

		return todos;
	}

	private render(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();

		this.createButtonControls(container);

		const root = this.buildFileTree();
		this.renderTree(root, container);
	}

	private createButtonControls(container: HTMLElement): void {
		const buttonContainer = container.createEl("div", { cls: "todo-tree-buttons" });
		const expandButton = buttonContainer.createEl("button", { text: "Expand All" });
		const collapseButton = buttonContainer.createEl("button", { text: "Collapse All" });

		expandButton.onclick = () => this.expandAllFolders(container);
		collapseButton.onclick = () => this.collapseAllFolders(container);
	}

	private expandAllFolders(container: HTMLElement): void {
		container.findAll("details").forEach((el) => {
			const detailEl = el as HTMLDetailsElement;
			detailEl.open = true;
			const summary = detailEl.querySelector("summary");
			if (summary) {
				const folderPath = this.calculateFolderPath(detailEl);
				this.expandedFolders.add(folderPath);
			}
		});
	}

	private collapseAllFolders(container: HTMLElement): void {
		container.findAll("details").forEach((el) => {
			(el as HTMLDetailsElement).open = false;
		});
		this.expandedFolders.clear();
	}

	private renderTree(node: FileTree, container: HTMLElement, level = 0, currentPath = ""): void {
		if (!node.hasTodos) {
			return;
		}

		if (node.isFile) {
			const fileEl = container.createEl("div", { cls: "todo-file" });
			fileEl.style.paddingLeft = `${level * 12}px`;

			const fileNameEl = fileEl.createEl("div", { cls: "todo-file-name" });
			fileNameEl.createSpan({ text: node.name });
			fileNameEl.createSpan({
				text: ` (${node.todoCount})`,
				cls: "todo-count-badge"
			});

			const matches = this.todos[node.path];
			matches.forEach(({ text, line }) => {
				const todoEl = fileEl.createEl("div", { cls: "todo-item" });
				const iconEl = todoEl.createSpan({ cls: "todo-item-icon" });
				const textEl = todoEl.createSpan({ text: text });

				const lowerCaseText = text.toLowerCase();
				if (lowerCaseText.includes("todo")) {
					setIcon(iconEl, "check-square");
				} else if (lowerCaseText.includes("fixme")) {
					setIcon(iconEl, "bug");
				} else if (lowerCaseText.includes("note")) {
					setIcon(iconEl, "pencil");
				} else {
					setIcon(iconEl, "check-square");
				}

				todoEl.onclick = async () => {
					const tfile = this.app.vault.getAbstractFileByPath(node.path);
					if (tfile instanceof TFile) {
						const leaves = this.app.workspace.getLeavesOfType("markdown");
						let leaf = leaves.find(leaf => (leaf.view as MarkdownView).file === tfile);
						if (!leaf) {
							leaf = this.app.workspace.getLeaf(true);
							await leaf.openFile(tfile);
						}
						this.app.workspace.setActiveLeaf(leaf, { focus: true });
						const mdView = leaf.view as MarkdownView;
						const editor = mdView.editor;

						// Position cursor and scroll to the line
						editor.setCursor({ line, ch: 0 });
						editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);

						// Add highlighting with delay to ensure editor is ready
						setTimeout(() => {
							this.highlightTodoLine(editor, line, text);
						}, 100);
					}
				};
			});
		} else {
			if (node.name !== "root") {
				const folderPath = currentPath ? `${currentPath}/${node.name}` : node.name;
				const details = container.createEl("details", { cls: "todo-folder" });
				details.style.paddingLeft = `${level * 12}px`;

				// Restore expansion state
				if (this.expandedFolders.has(folderPath)) {
					details.open = true;
				}

				const summary = details.createEl("summary", { cls: "todo-folder-name" });
				summary.createSpan({ text: node.name });
				summary.createSpan({
					text: ` (${node.todoCount})`,
					cls: "todo-count-badge"
				});

				// Store the folder path as a data attribute for reliable persistence
				details.setAttribute("data-folder-path", folderPath);

				// Add event listener to track expansion changes
				details.addEventListener("toggle", () => {
					if (details.open) {
						this.expandedFolders.add(folderPath);
					} else {
						this.expandedFolders.delete(folderPath);
					}
				});

				for (const child of Object.values(node.children)) {
					this.renderTree(child, details, level + 1, folderPath);
				}
			} else {
				for (const child of Object.values(node.children)) {
					this.renderTree(child, container, level, currentPath);
				}
			}
		}
	}

	private buildFileTree(): FileTree {
		const root: FileTree = { name: "root", children: {}, isFile: false, path: "", hasTodos: false, todoCount: 0 };

		for (const file in this.todos) {
			const parts = file.split("/");
			let currentNode = root;
			for (let i = 0; i < parts.length; i++) {
				const part = parts[i];
				if (!currentNode.children[part]) {
					currentNode.children[part] = {
						name: part,
						children: {},
						isFile: i === parts.length - 1,
						path: parts.slice(0, i + 1).join("/"),
						hasTodos: false,
						todoCount: 0,
					};
				}
				currentNode = currentNode.children[part];
			}
			currentNode.hasTodos = true;
			// Set the todo count for files
			if (currentNode.isFile) {
				currentNode.todoCount = this.todos[file].length;
			}
		}

		this.propagateTodoCounts(root);
		return root;
	}

	private propagateTodoCounts(node: FileTree): number {
		if (node.isFile) {
			return node.todoCount;
		}

		let totalCount = 0;
		let hasTodos = false;

		for (const child of Object.values(node.children)) {
			const childCount = this.propagateTodoCounts(child);
			totalCount += childCount;
			if (childCount > 0) {
				hasTodos = true;
			}
		}

		node.todoCount = totalCount;
		node.hasTodos = hasTodos;
		return totalCount;
	}
}
