export type PreviewRect = { x: number; y: number; width: number; height: number };
export type PreviewPoint = { x: number; y: number };

export function computerPreviewSize(width: number, height: number, requestedMaximum = 200) {
  const maximum = Number.isFinite(requestedMaximum) ? Math.min(400, Math.max(1, requestedMaximum)) : 200;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { width: maximum, height: maximum };
  const scale = Math.min(maximum / width, maximum / height);
  return { width: Math.max(1, width * scale), height: Math.max(1, height * scale) };
}

export function clampComputerPreview(point: PreviewPoint, size: { width: number; height: number }, host: { width: number; height: number }) {
  const insetX = Math.min(24, Math.max(0, (host.width - size.width) / 2));
  const insetY = Math.min(24, Math.max(0, (host.height - size.height) / 2));
  return {
    x: Math.max(insetX, Math.min(Math.max(insetX, host.width - size.width - insetX), point.x)),
    y: Math.max(insetY, Math.min(Math.max(insetY, host.height - size.height - insetY), point.y)),
  };
}

export function placeComputerPreview(size: { width: number; height: number }, host: { width: number; height: number }, obstacles: PreviewRect[], dragged: PreviewPoint | null) {
  if (dragged) return clampComputerPreview(dragged, size, host);
  const anchors = [
    { x: host.width - size.width - 24, y: 24 },
    { x: 24, y: 24 },
    { x: host.width - size.width - 24, y: host.height - size.height - 24 },
    { x: 24, y: host.height - size.height - 24 },
  ];
  const expanded = obstacles.filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => ({ x: rect.x - 12, y: rect.y - 12, width: rect.width + 24, height: rect.height + 24 }));
  const overlap = (point: PreviewPoint, rect: PreviewRect) =>
    Math.max(0, Math.min(point.x + size.width, rect.x + rect.width) - Math.max(point.x, rect.x)) *
    Math.max(0, Math.min(point.y + size.height, rect.y + rect.height) - Math.max(point.y, rect.y));
  const candidates = anchors.map((anchor, priority) => {
    let point = clampComputerPreview(anchor, size, host);
    for (let iteration = 0; iteration < 6; iteration++) {
      const obstacle = expanded.find((rect) => overlap(point, rect) > 0);
      if (!obstacle) break;
      const moves = [
        { x: obstacle.x - size.width, y: point.y }, { x: obstacle.x + obstacle.width, y: point.y },
        { x: point.x, y: obstacle.y - size.height }, { x: point.x, y: obstacle.y + obstacle.height },
      ].map((next) => clampComputerPreview(next, size, host));
      moves.sort((a, b) => overlap(a, obstacle) - overlap(b, obstacle) ||
        Math.hypot(a.x - point.x, a.y - point.y) - Math.hypot(b.x - point.x, b.y - point.y));
      point = moves[0];
    }
    const area = expanded.reduce((sum, rect) => sum + overlap(point, rect), 0);
    const score = (area > 0 ? 1e9 : 0) + area * 1e4 + priority * 1e6 +
      (point.x - anchors[0].x) ** 2 + (point.y - anchors[0].y) ** 2;
    return { point, score };
  });
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0].point;
}
