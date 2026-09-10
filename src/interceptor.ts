// Runs in the page's MAIN world at document_start (see manifest.json).
//
// ChatGPT no longer plays read-aloud audio through an <audio> element — it decodes
// the /backend-api/synthesize response with Web Audio, so there is nothing in the
// DOM for the content script to control. Instead, we patch window.fetch:
// the real audio stream is piped into our own <audio> element (which the content
// script binds its player UI to), and ChatGPT receives a ~0.2s silent AAC clip so
// its own playback ends immediately without audible overlap and its UI resets.
//
// This script cannot use chrome.* APIs (MAIN world); it talks to the content
// script via window.postMessage.

const SYNTHESIZE_PATH = '/backend-api/synthesize';
const AUDIO_ELEMENT_ID = 'chatgpt-read-aloud-controls-audio';
const MESSAGE_SOURCE = 'chatgpt-read-aloud-controls';

// 0.2s of silence, AAC-LC in an ADTS container — the same format synthesize returns.
const SILENT_AAC_BASE64 =
  '//FYQAOf/N4CAExhdmM2Mi4xMS4xMDAAAjBADv/xWEABf/wBGCAH//FYQAF//AEYIAf/8VhAAX/8ARggB//xWEABf/wBGCAH';

let requestCounter = 0;

function postToContentScript(
  type: 'SYNTHESIZE_REQUEST_INTERCEPTED' | 'SYNTHESIZE_REQUEST_COMPLETED' | 'SYNTHESIZE_REQUEST_FAILED',
  requestId: string,
  url: string,
  extra: Record<string, unknown> = {},
): void {
  window.postMessage({ source: MESSAGE_SOURCE, type, requestId, url, ...extra }, window.location.origin);
}

function silentResponse(): Response {
  const bytes = Uint8Array.from(atob(SILENT_AAC_BASE64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'audio/aac' },
  });
}

function createAudioElement(): HTMLAudioElement {
  const previous = document.getElementById(AUDIO_ELEMENT_ID) as HTMLAudioElement | null;
  if (previous) {
    // Release the previous clip's blob if the content script hasn't already
    // (e.g. rapid consecutive read-alouds)
    if (previous.src.startsWith('blob:')) URL.revokeObjectURL(previous.src);
    previous.remove();
  }
  const audio = document.createElement('audio');
  audio.id = AUDIO_ELEMENT_ID;
  audio.style.display = 'none';
  audio.preload = 'auto';
  document.body.appendChild(audio);
  return audio;
}

// Buffer the whole clip into a Blob, point the <audio> element at it, and start
// playback. This is the most robust option: progressive MediaSource playback of
// raw ADTS — or of a hand-rolled fragmented-MP4 remux — is rejected by
// Chromium's decoder at fragment boundaries during live playback
// (PIPELINE_ERROR_DECODE), whereas a complete Blob decodes reliably. The
// trade-off is that playback starts only once the download finishes; the player
// UI shows a loading state until then.
async function playResponseAudio(audio: HTMLAudioElement, body: ReadableStream<Uint8Array>): Promise<void> {
  const blob = await new Response(body).blob();
  audio.src = URL.createObjectURL(blob);
  // The user just clicked "Read aloud" so transient activation should allow
  // autoplay; if the browser blocks it, the player UI's play button works.
  audio.play().catch(() => {});
}

// Match on the parsed pathname, not a raw substring — a URL that merely
// *contains* "/backend-api/synthesize" in a query param or fragment must not
// be captured (swallowing a non-audio response would corrupt ChatGPT's state).
function isSynthesizeRequest(rawUrl: string): boolean {
  try {
    return new URL(rawUrl, window.location.origin).pathname === SYNTHESIZE_PATH;
  } catch {
    return false;
  }
}

const originalFetch = window.fetch;
window.fetch = async function (
  this: unknown,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input?.url ?? '');

  if (!isSynthesizeRequest(url)) {
    return originalFetch.call(this, input, init);
  }

  const requestId = `ra-${++requestCounter}`;
  postToContentScript('SYNTHESIZE_REQUEST_INTERCEPTED', requestId, url);

  let response: Response;
  try {
    response = await originalFetch.call(this, input, init);
  } catch (error) {
    postToContentScript('SYNTHESIZE_REQUEST_FAILED', requestId, url, { error: String(error) });
    throw error;
  }

  if (!response.ok || !response.body) {
    postToContentScript('SYNTHESIZE_REQUEST_FAILED', requestId, url, {
      error: `HTTP ${response.status}`,
    });
    return response;
  }

  // Only substitute the silent clip for a genuine audio response — anything
  // else passes through untouched so ChatGPT's own handling is never broken
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.startsWith('audio/')) {
    postToContentScript('SYNTHESIZE_REQUEST_FAILED', requestId, url, {
      error: `Unexpected content-type: ${contentType || '(none)'}`,
    });
    return response;
  }

  const audio = createAudioElement();
  playResponseAudio(audio, response.body)
    .then(() => {
      // Fires once the audio element has a playable source, so the content
      // script binds its player UI to a ready element.
      postToContentScript('SYNTHESIZE_REQUEST_COMPLETED', requestId, url, {
        statusCode: response.status,
      });
    })
    .catch((error) => {
      // Stream aborted mid-download (e.g. the player was closed)
      postToContentScript('SYNTHESIZE_REQUEST_FAILED', requestId, url, { error: String(error) });
    });

  return silentResponse();
};

export {};
