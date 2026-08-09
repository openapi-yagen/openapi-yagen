import {copyFile, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const websiteDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceLogo = resolve(websiteDir, '..', 'openapi-yagen.png');
const imageDir = resolve(websiteDir, '.generated-static', 'img');

await mkdir(imageDir, {recursive: true});
await copyFile(sourceLogo, resolve(imageDir, 'openapi-yagen.png'));
await copyFile(sourceLogo, resolve(imageDir, 'openapi-yagen-social.png'));
