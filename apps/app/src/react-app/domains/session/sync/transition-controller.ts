export type TransitionState = "idle" | "switching" | "recovering" | "failed";

export type RenderSource = "cache" | "live" | "empty" | "error" | "recovering";

export type SessionRenderModel = {
  intendedSessionId: string;
  renderedSessionId: string | null;
  transitionState: TransitionState;
  renderSource: RenderSource;
};

export function deriveSessionRenderModel(input: {
  intendedSessionId: string;
  renderedSessionId: string | null;
  hasSnapshot: boolean;
  isFetching: boolean;
  isError: boolean;
}): SessionRenderModel {
  if (input.isError && input.renderedSessionId && input.renderedSessionId !== input.intendedSessionId) {
    return {
      intendedSessionId: input.intendedSessionId,
      renderedSessionId: input.renderedSessionId,
      transitionState: "recovering",
      renderSource: "recovering",
    };
  }

  if (input.isError) {
    return {
      intendedSessionId: input.intendedSessionId,
      renderedSessionId: input.renderedSessionId,
      transitionState: "failed",
      renderSource: "error",
    };
  }

  if (input.renderedSessionId && input.renderedSessionId !== input.intendedSessionId) {
    return {
      intendedSessionId: input.intendedSessionId,
      renderedSessionId: input.renderedSessionId,
      transitionState: "switching",
      renderSource: "cache",
    };
  }

  if (!input.hasSnapshot) {
    return {
      intendedSessionId: input.intendedSessionId,
      renderedSessionId: input.renderedSessionId,
      transitionState: input.isFetching ? "switching" : "idle",
      renderSource: "empty",
    };
  }

  return {
    intendedSessionId: input.intendedSessionId,
    renderedSessionId: input.renderedSessionId,
    transitionState: input.isFetching ? "switching" : "idle",
    renderSource: "live",
  };
}

export type ComposerAvailabilityInput = {
  intendedSessionId: string;
  renderedSessionId: string | null;
  hasSnapshot: boolean;
  isFetching: boolean;
  /** Transcript/snapshot load failure. */
  snapshotError: boolean;
  /**
   * A rejected send or an unconfirmed delivery. It is a transcript notice, not
   * a load failure: folding it into `isError` used to fail the session
   * transition and lock the editor until the surface was remounted.
   */
  deliveryError: boolean;
  modelUnavailable: boolean;
};

export type ComposerAvailability = {
  model: SessionRenderModel;
  disabled: boolean;
};

export function deriveComposerAvailability(input: ComposerAvailabilityInput): ComposerAvailability {
  // `deliveryError` is intentionally not read: it belongs to the transcript
  // notice, never to the load transition that disables the editor.
  const model = deriveSessionRenderModel({
    intendedSessionId: input.intendedSessionId,
    renderedSessionId: input.renderedSessionId,
    hasSnapshot: input.hasSnapshot,
    isFetching: input.isFetching,
    isError: input.snapshotError,
  });
  return { model, disabled: model.transitionState !== "idle" || input.modelUnavailable };
}
