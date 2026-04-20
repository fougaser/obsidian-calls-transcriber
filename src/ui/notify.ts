import { Notice } from 'obsidian';

export function showInAppNotice(message: string, timeoutMs = 5000): void {
    new Notice(message, timeoutMs);
}

export function showOsNotification(title: string, body: string): void {
    if (typeof Notification === 'undefined') return;
    try {
        // eslint-disable-next-line no-new
        new Notification(title, { body });
    } catch {
        // Some environments refuse construction; silently ignore.
    }
}
