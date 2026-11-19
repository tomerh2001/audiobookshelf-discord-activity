import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Nuxt 2 generates a runtime configuration and loading-error handler inline.
// Discord's iframe CSP permits same-origin scripts, but not inline execution.
export async function externalizeScripts(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) continue;
        if (!entry.name.endsWith('.html')) continue;
        const filename = path.join(directory, entry.name);
        const html = await readFile(filename, 'utf8');
        const files = new Map();
        const output = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (original, attributes, content) => {
            if (/\bsrc\s*=/i.test(attributes) || !content.trim()) return original;
            const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1]?.toLowerCase();
            if (type && !['text/javascript', 'application/javascript', 'module'].includes(type)) return original;
            const hash = createHash('sha256').update(content).digest('hex').slice(0, 20);
            const script = `activity-bootstrap-${hash}.js`;
            files.set(script, content + '\n');
            return `<script${attributes} src="/${script}"></script>`;
        });
        for (const [name, content] of files) await writeFile(path.join(directory, name), content);
        await writeFile(filename, output);
    }
}
