// Shared KTX2 encoding for the texture generators. Requires Khronos KTX-Software's `ktx` CLI.
import { spawnSync } from 'node:child_process';
import { renameSync, rmSync } from 'node:fs';

import { siblingTempPath } from './write-file.ts';

export function ensureKtx(): void {
    const result = spawnSync('ktx', ['create', '--help'], { stdio: 'ignore' });
    if (result.error || result.status !== 0) {
        console.error(
            'The "ktx create" command from Khronos KTX-Software is required to encode KTX2 textures.\n' +
                'Install or upgrade it first: brew install ktx-software\n' +
                'Other platforms: https://github.com/KhronosGroup/KTX-Software/releases',
        );
        process.exit(1);
    }
}

export function createKtx2(
    outputPath: string,
    inputPaths: string[],
    colorSpace: 'srgb' | 'linear',
    mipmapWrap: 'wrap' | 'clamp' = 'clamp',
): void {
    const srgb = colorSpace === 'srgb';
    // ktx infers its container from the extension, so keep it on the temporary path too.
    const tempPath = siblingTempPath(outputPath);
    const result = spawnSync(
        'ktx',
        [
            'create',
            '--format',
            srgb ? 'R8G8B8A8_SRGB' : 'R8G8B8A8_UNORM',
            '--assign-tf',
            colorSpace,
            '--assign-primaries',
            srgb ? 'bt709' : 'none',
            '--encode',
            // `uastc` is understood by KTX-Software 4.3+; newer releases name it uastc-ldr-4x4.
            'uastc',
            '--uastc-quality',
            '2',
            '--zstd',
            '9',
            '--generate-mipmap',
            '--mipmap-wrap',
            mipmapWrap,
            ...(inputPaths.length > 1 ? ['--layers', String(inputPaths.length)] : []),
            ...inputPaths,
            tempPath,
        ],
        { stdio: 'inherit' },
    );

    if (result.error || result.status !== 0) {
        rmSync(tempPath, { force: true });
        console.error(`ktx create failed for ${outputPath}`);
        process.exit(1);
    }

    renameSync(tempPath, outputPath);
    console.log(`Generated ${outputPath} (${inputPaths.length} layers)`);
}
