// Background script for handling webRequest interception
console.log('[ChatGPT Read Aloud Controller]: Background script loaded');

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    console.log('[ChatGPT Read Aloud Controller]: Intercepted synthesize request', details.url);

    // Send message to content script about the intercepted request
    chrome.tabs
      .sendMessage(details.tabId, {
        type: 'SYNTHESIZE_REQUEST_INTERCEPTED',
        requestId: details.requestId,
        url: details.url,
      })
      .catch(() => {
        // Tab might not be ready, ignore error
      });

    return {};
  },
  {
    urls: ['https://chatgpt.com/backend-api/synthesize*'],
    types: ['xmlhttprequest'],
  },
  ['requestBody'],
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.statusCode === 200) {
      console.log('[ChatGPT Read Aloud Controller]: Synthesize request completed successfully');

      // Send message to content script about successful response
      chrome.tabs
        .sendMessage(details.tabId, {
          type: 'SYNTHESIZE_REQUEST_COMPLETED',
          requestId: details.requestId,
          url: details.url,
          statusCode: details.statusCode,
        })
        .catch(() => {
          // Tab might not be ready, ignore error
        });
    }
  },
  {
    urls: ['https://chatgpt.com/backend-api/synthesize*'],
    types: ['xmlhttprequest'],
  },
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    console.log('[ChatGPT Read Aloud Controller]: Synthesize request failed', details.error);

    // Send message to content script about failed response
    chrome.tabs
      .sendMessage(details.tabId, {
        type: 'SYNTHESIZE_REQUEST_FAILED',
        requestId: details.requestId,
        url: details.url,
        error: details.error,
      })
      .catch(() => {
        // Tab might not be ready, ignore error
      });
  },
  {
    urls: ['https://chatgpt.com/backend-api/synthesize*'],
    types: ['xmlhttprequest'],
  },
);
