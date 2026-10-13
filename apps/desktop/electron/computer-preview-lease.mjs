// Presentation ownership is separate from input authority. The native helper
// has no thread identity, so the renderer must still require one active run.
export function createComputerPreviewLease({ readPreview, captureSource, openPreview, sourceChanged, now = Date.now }) {
  let lease = null;
  let captureGeneration = 0;
  const matches = (owner, scope) => Boolean(lease && scope && owner === lease.owner &&
    scope.leaseId === lease.scope.leaseId && scope.sessionId === lease.scope.sessionId &&
    scope.runStartedAt === lease.scope.runStartedAt);
  const sameTarget = (a, b) => Boolean(a && b && a.presentationId === b.presentationId &&
    a.helperPid === b.helperPid && a.pid === b.pid && a.windowNumber === b.windowNumber);
  const clearSource = () => { captureGeneration++; sourceChanged(null); };
  const read = async (owner, scope) => {
    if (!matches(owner, scope)) return null;
    const startedLease = lease;
    const preview = await readPreview();
    if (lease !== startedLease || !matches(owner, scope)) return null;
    if (!preview || preview.capturedAt * 1000 < scope.runStartedAt ||
        preview.capturedAt * 1000 > now() + 5_000 ||
        (lease.preview && (preview.helperPid !== lease.preview.helperPid ||
          preview.presentationId !== lease.preview.presentationId ||
          preview.revision < lease.preview.revision || preview.capturedAt < lease.preview.capturedAt ||
          (preview.revision === lease.preview.revision && !sameTarget(preview, lease.preview))))) {
      clearSource();
      return null;
    }
    if (!sameTarget(preview, lease.preview)) clearSource();
    lease.preview = preview;
    return preview;
  };
  return {
    begin(owner, scope) {
      if (!scope || typeof scope.sessionId !== "string" || !scope.sessionId ||
          typeof scope.leaseId !== "string" || !scope.leaseId ||
          !Number.isFinite(scope.runStartedAt) || scope.runStartedAt <= 0 || scope.runStartedAt > now() + 5_000) return false;
      clearSource();
      lease = { owner, scope: { ...scope }, preview: null };
      return true;
    },
    release(owner, scope) {
      if (!matches(owner, scope)) return false;
      lease = null;
      clearSource();
      return true;
    },
    releaseOwner(owner) {
      if (lease?.owner !== owner) return;
      lease = null;
      clearSource();
    },
    read,
    async capture(owner, scope, target) {
      const preview = await read(owner, scope);
      if (!sameTarget(preview, target)) return null;
      const startedLease = lease;
      const startedGeneration = captureGeneration;
      const source = await captureSource(preview);
      // Capture-source enumeration can finish after navigation, hide, target
      // change or a new run. An obsolete request cannot grant capture access.
      if (lease !== startedLease || captureGeneration !== startedGeneration || !matches(owner, scope) || !sameTarget(lease.preview, target)) return null;
      sourceChanged(source);
      return source?.id ?? null;
    },
    async open(owner, scope, target) {
      const preview = await read(owner, scope);
      if (!sameTarget(preview, target)) return false;
      return openPreview(preview);
    },
  };
}
