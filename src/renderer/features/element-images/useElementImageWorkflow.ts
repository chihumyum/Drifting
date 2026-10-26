import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';

import { readArtStyle } from '../../domain/material-provenance';
import { codexSubscription } from '../../lib/codex-subscription';
import type { ImageInboxEntry } from '../../platform';
import type { GeneratedImageCommands } from '../../usecase/useGeneratedImages';
import { selectElementCandidates, useImageInboxStore } from '../../store/image-inbox-store';
import { useProjectStore } from '../../store/project-store';
import type { ElementImageGenerateRequest } from './ElementImageGenerateForm';
import { useElementImageGeneration } from './element-image-task';

const log = loglevel.getLogger('elementImageWorkflow');
log.setLevel(loglevel.levels.WARN);

/**
 * State behind the element image entry in the editor top bar: the generation
 * form, the background Agent task and the element's inbox candidates.
 */
export function useElementImageWorkflow(input: {
  projectId: string | null;
  elementId: string | null;
  elementName: string;
  categoryName: string | null;
  commands: GeneratedImageCommands;
}) {
  const { projectId, elementId, elementName, categoryName, commands } = input;
  const { t } = useTranslation();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [busyCandidateId, setBusyCandidateId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const projectKvJson = useProjectStore((state) =>
    state.currentProject?.id === projectId ? state.currentProject.kvJson : null,
  );
  const styleText = useMemo(() => readArtStyle(projectKvJson), [projectKvJson]);
  const allCandidates = useImageInboxStore((state) => state.candidates);
  const quota = useImageInboxStore((state) => state.quota);
  const candidates = useMemo(
    () => selectElementCandidates(allCandidates, elementId),
    [allCandidates, elementId],
  );
  const generation = useElementImageGeneration(projectId, elementId);

  useEffect(() => {
    if (projectId) void useImageInboxStore.getState().load(projectId);
  }, [projectId]);

  /** Called when the generation form opens: re-reads the ChatGPT sign-in. */
  const prepareGenerate = useCallback(() => {
    setActionError(null);
    void codexSubscription
      .status()
      .then((status) => setSignedIn(status.signedIn))
      .catch(() => setSignedIn(false));
  }, []);

  const submit = useCallback(
    (request: ElementImageGenerateRequest) => {
      void (async () => {
        if (request.styleText !== styleText) {
          try {
            await commands.saveArtStyle(request.styleText);
          } catch (error) {
            log.error('Failed to save the art style', error);
          }
        }
        await generation.start({
          elementName,
          categoryName,
          count: request.count,
          extraPrompt: request.extraPrompt || null,
          styleText: request.styleText || null,
        });
      })();
    },
    [categoryName, commands, elementName, generation, styleText],
  );

  const runCandidateAction = useCallback(
    async (candidate: ImageInboxEntry, action: (candidate: ImageInboxEntry) => Promise<void>) => {
      setBusyCandidateId(candidate.id);
      setActionError(null);
      try {
        await action(candidate);
        setPreviewId((current) => (current === candidate.id ? null : current));
      } catch (error) {
        log.error('Candidate action failed', candidate.id, error);
        setActionError(
          t('elementEditor.imageGeneration.actionFailed', {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        setBusyCandidateId(null);
      }
    },
    [t],
  );

  const onSetPortrait = useCallback(
    (candidate: ImageInboxEntry) => {
      if (!elementId) return;
      void runCandidateAction(candidate, (c) => commands.setPortraitFromCandidate(c, elementId));
    },
    [commands, elementId, runCandidateAction],
  );
  const onKeep = useCallback(
    (candidate: ImageInboxEntry) => {
      if (!elementId) return;
      void runCandidateAction(candidate, (c) => commands.keepCandidate(c, elementId));
    },
    [commands, elementId, runCandidateAction],
  );
  const onDiscard = useCallback(
    (candidate: ImageInboxEntry) => {
      void runCandidateAction(candidate, (c) => commands.discardCandidate(c));
    },
    [commands, runCandidateAction],
  );

  const startError = generation.error
    ? t('elementEditor.imageGeneration.startFailed', { error: generation.error })
    : null;
  const previewCandidate = previewId
    ? (candidates.find((candidate) => candidate.id === previewId) ?? null)
    : null;

  return {
    prepareGenerate,
    generationState: generation.state,
    formProps: {
      styleText,
      quota,
      blockedReason: signedIn === false ? t('elementEditor.imageGeneration.needsSignIn') : null,
      onSubmit: submit,
    },
    candidateProps: {
      candidates,
      generation: generation.state,
      busyCandidateId,
      error: actionError ?? startError,
      onOpenSession: () => void generation.openSession(),
      onSetPortrait,
      onKeep,
      onDiscard,
      onPreview: (candidate: ImageInboxEntry) => setPreviewId(candidate.id),
    },
    preview: previewCandidate
      ? {
          candidate: previewCandidate,
          busy: busyCandidateId !== null,
          onClose: () => setPreviewId(null),
          onSetPortrait,
          onKeep,
        }
      : null,
  };
}
