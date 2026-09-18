import { MODES, runManifest } from './model.js';

export function downloadInventory(session, selection = {}) {
  if (!session) return { groups: [], files: [], selected: 0, ready: 0, cached: 0, bytes: 0 };
  const settings = { ...session.settings, ...selection };
  const manifest = runManifest({ ...session, settings });
  const lastFiles = session.lastExport?.files || [];
  const describe = (job, kind, asset, path, variant = null) => {
    const selected = kind === 'image'
      ? session.mode === MODES.IMAGE || settings.includeImages === true
      : settings.variants.includes(variant);
    const saved = Boolean(asset?.assetId);
    const archived = saved && selected && lastFiles.some(file => file.assetId === asset.assetId && file.path === path);
    return {
      key: `${job.index}:${kind}:${variant || 1}`,
      index: job.index, kind, variant, selected, path,
      assetId: asset?.assetId || null,
      type: asset?.type || null,
      size: saved ? asset.size || 0 : 0,
      sha256: asset?.sha256 || null,
      state: archived ? 'archived' : saved ? 'local' : asset ? 'available' : 'pending',
      label: kind === 'image' ? `Image ${job.index}` : `Video ${job.index} · Variant ${variant}`,
    };
  };
  const groups = [...session.jobs].sort((a, b) => a.index - b.index).map(job => {
    const mapping = manifest.jobs.find(item => item.index === job.index);
    const files = [describe(job, 'image', job.image, mapping.image?.filename || null)];
    if (session.mode !== MODES.IMAGE) {
      for (const variant of [1, 2, 3, 4]) {
        files.push(describe(job, 'video', job.variants.find(item => item.variant === variant),
          mapping.variants.find(item => item.variant === variant)?.filename || null, variant));
      }
    }
    return { index: job.index, prompt: job.imagePrompt || job.videoPrompt || '', originalName: job.originalName,
      verified: job.upload?.verified === true, files };
  });
  const files = groups.flatMap(group => group.files);
  const selected = files.filter(file => file.selected);
  return {
    groups, files, selected: selected.length,
    ready: selected.filter(file => file.assetId).length,
    cached: files.filter(file => file.assetId).length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}
