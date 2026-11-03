import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = path.join(root, 'apps/ui/public');
const catalog = JSON.parse((await readFile(path.join(root, 'assets/models/index.json'), 'utf8')).replace(/^\uFEFF/, ''));
const models = [];
for (const model of catalog) {
  if (model.selectable === false) continue;
  if (!/^[a-z0-9_]+$/.test(model.id)) throw new Error('Invalid model identifier');
  const source = path.resolve(root, model.preview_file);
  if (!source.startsWith(path.join(root, 'assets/models') + path.sep)) throw new Error('Asset outside model directory');
  const bytes = await readFile(source);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== model.preview_sha256) throw new Error(`Model hash mismatch: ${model.id}`);
  const destination = path.join(publicRoot, 'models', model.id);
  await mkdir(destination, { recursive: true });
  await copyFile(source, path.join(destination, 'preview.glb'));
  const fields = ['id','name','configuration','radius_m','sha256','preview_sha256','installation_source','physical_scale_calibrated','scale_note','source_provider','source_page','license','license_url','source_model_id','source_sha256','source_scale','source_scale_basis','collection_id','source_coordinate_system','body_axes_source'];
  const item = Object.fromEntries(fields.filter(k => k in model).map(k => [k,model[k]]));
  // Same CLIENT_TO_ENGINE basis multiplication as ModelCatalog.public().
  item.source_to_body = [model.source_to_body[0],model.source_to_body[2],model.source_to_body[1],model.source_to_body[3]];
  item.preview_url = `./models/${model.id}/preview.glb?v=${digest}`;
  models.push(item);
}
await writeFile(path.join(publicRoot, 'catalog.json'), JSON.stringify(models, null, 2) + '\n');
console.log(`Prepared ${models.length} verified local browser models. No upload performed.`);
