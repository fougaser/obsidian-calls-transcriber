export interface TabDefinition {
    id: string;
    label: string;
    render(panel: HTMLElement): void;
}

export interface TabController {
    root: HTMLElement;
    activateTab(id: string): void;
    getActiveTab(): string;
}

export function renderTabs(
    container: HTMLElement,
    tabs: TabDefinition[],
    initialTabId?: string
): TabController {
    const root = container.createDiv({ cls: 'ct-tabs' });
    const nav = root.createDiv({ cls: 'ct-tabs-nav' });
    const panel = root.createDiv({ cls: 'ct-tabs-panel' });

    const buttons = new Map<string, HTMLButtonElement>();
    let activeId = initialTabId && tabs.some(t => t.id === initialTabId) ? initialTabId : tabs[0]?.id ?? '';

    const activate = (id: string): void => {
        const target = tabs.find(t => t.id === id);
        if (!target) return;
        activeId = id;
        for (const [tid, btn] of buttons) {
            btn.toggleClass('is-active', tid === id);
        }
        panel.empty();
        target.render(panel);
    };

    for (const tab of tabs) {
        const btn = nav.createEl('button', { cls: 'ct-tabs-btn', text: tab.label });
        btn.type = 'button';
        btn.addEventListener('click', () => activate(tab.id));
        buttons.set(tab.id, btn);
    }

    if (activeId.length > 0) activate(activeId);

    return {
        root,
        activateTab: activate,
        getActiveTab: () => activeId
    };
}
