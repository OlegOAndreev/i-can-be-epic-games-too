// Writes through a sibling temporary file so an interrupted generator cannot leave a truncated
// asset behind. The temporary name keeps the original extension, which some tools infer from.
import { renameSync, rmSync, writeFileSync } from 'node:fs';

export function siblingTempPath(path: string): string {
    const slash = path.lastIndexOf('/');
    const dot = path.lastIndexOf('.');
    if (dot <= slash) {
        return `${path}.tmp-${process.pid}`;
    }
    return `${path.slice(0, dot)}.tmp-${process.pid}${path.slice(dot)}`;
}

export function writeFileAtomic(path: string, data: string | Uint8Array): void {
    const tempPath = siblingTempPath(path);
    try {
        writeFileSync(tempPath, data);
        renameSync(tempPath, path);
    } catch (error) {
        rmSync(tempPath, { force: true });
        throw error;
    }
}
