/**
 * Draws shelf covers off the page, on an OffscreenCanvas, so a shelf of many
 * books (or a change of cover style) never holds up the sea of characters
 * behind it. One cover at a time; the page sends the next when one returns.
 */
import type { CoverRequest } from './book';
import { drawCoverFiles } from './draw';
import { COVER_HEIGHT, COVER_WIDTH } from './paint';
import type { CoverStyleId } from './styles';

interface DrawRequest {
  id: number;
  style: CoverStyleId;
  request: CoverRequest;
}
interface DrawResponse {
  id: number;
  files?: Blob[];
  dark?: boolean;
  error?: string;
}

// Cast around the DOM `self`/`postMessage` typings (this file runs in a worker).
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<DrawRequest>) => void) | null;
  postMessage: (msg: DrawResponse) => void;
};

let canvas: OffscreenCanvas | null = null;

scope.onmessage = (e) => {
  const { id, style, request } = e.data;
  canvas ??= new OffscreenCanvas(COVER_WIDTH, COVER_HEIGHT);
  drawCoverFiles(style, request, canvas).then(
    ({ files, dark }) => scope.postMessage({ id, files, dark }),
    (error: unknown) => scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) }),
  );
};
