interface AudioPlayerState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  audioUrl: string | null;
  hasError: boolean;
  errorMessage: string;
  isLoading: boolean;
  isStreaming: boolean;
  playbackRate: number;
  isMuted: boolean;
}

interface SynthesizeMessage {
  source: string;
  type:
    | 'SYNTHESIZE_REQUEST_INTERCEPTED'
    | 'SYNTHESIZE_REQUEST_COMPLETED'
    | 'SYNTHESIZE_REQUEST_FAILED';
  requestId: string;
  url: string;
  statusCode?: number;
  error?: string;
}

// Set to true for verbose console diagnostics during development; the
// published build stays quiet (errors still surface via console.error)
const DEBUG = false;
function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}

// Must match src/interceptor.ts
const MESSAGE_SOURCE = 'chatgpt-read-aloud-controls';
const AUDIO_ELEMENT_ID = 'chatgpt-read-aloud-controls-audio';
const FIND_AUDIO_MAX_ATTEMPTS = 40; // × 500ms = 20s before giving up

// Persisted player geometry (per browser, via localStorage)
const GEOMETRY_STORAGE_KEY = 'chatgpt-read-aloud-controls:geometry';
const PLAYER_MIN_WIDTH = 320;
const PLAYER_MAX_WIDTH = 720;

// Selector for the native Read Aloud control, which now lives inside the
// "More actions" dropdown as a menu item.
const VOICE_ACTION_SELECTOR = 'button[data-testid="voice-play-turn-action-button"]';
const INLINE_BUTTON_CLASS = 'chatgpt-ra-inline-button';

interface PlayerGeometry {
  left?: number;
  top?: number;
  width?: number;
}

class ChatGPTReadAloudController {
  private audioPlayer: HTMLAudioElement | null = null;
  private playerUI: HTMLElement | null = null;
  private currentState: AudioPlayerState = {
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    audioUrl: null,
    hasError: false,
    errorMessage: '',
    isLoading: false,
    isStreaming: false,
    playbackRate: 1.0,
    isMuted: false,
  };
  private currentConversationId: string | null = null;
  private pendingRequestId: string | null = null;
  private findAudioAttempts = 0;
  private findAudioTimeoutId: number | null = null;
  private pollIntervalId: number | null = null;
  private inlineButtonScanQueued = false;
  private conversationScanQueued = false;

  constructor() {
    debugLog('[ChatGPT Read Aloud Controller]: Initializing extension');
    debugLog('[ChatGPT Read Aloud Controller]: Current URL:', window.location.href);
    this.setupMessageListener();
    this.observeConversationChanges();
    this.createPlayerUI(); // Player is always present
    this.observeAssistantTurns(); // Inject inline "Listen" buttons
    this.updateCurrentConversationId();
    debugLog('[ChatGPT Read Aloud Controller]: Initialization complete');
  }

  private setupMessageListener(): void {
    // Listen for messages posted by the MAIN-world interceptor (src/interceptor.ts)
    debugLog('[ChatGPT Read Aloud Controller]: Setting up message listener');
    window.addEventListener('message', (event: MessageEvent<SynthesizeMessage>) => {
      if (event.source !== window || event.data?.source !== MESSAGE_SOURCE) return;
      const message = event.data;
      debugLog('[ChatGPT Read Aloud Controller]: Received message:', message.type);

      switch (message.type) {
        case 'SYNTHESIZE_REQUEST_INTERCEPTED':
          // The user clicked "Read aloud": show the player right away in a
          // disabled state, then wait for the interceptor's audio element
          this.resetToInitialState();
          this.pendingRequestId = message.requestId;
          this.showPlayerDisabled();
          this.findAudioAttempts = 0;
          this.scheduleFindAudio(100);
          break;

        case 'SYNTHESIZE_REQUEST_COMPLETED':
          if (message.requestId === this.pendingRequestId && !this.audioPlayer) {
            debugLog('[ChatGPT Read Aloud Controller]: Synthesis completed, looking for audio');
            this.findAudioAttempts = 0;
            this.scheduleFindAudio(100);
          }
          break;

        case 'SYNTHESIZE_REQUEST_FAILED':
          if (message.requestId === this.pendingRequestId) {
            this.handleAudioError(`Request failed: ${message.error || 'Unknown error'}`);
          }
          break;
      }
    });
  }

  private findAndBindInterceptedAudio(): void {
    // The interceptor creates a dedicated audio element for the synthesize stream
    const targetAudio = document.getElementById(AUDIO_ELEMENT_ID) as HTMLAudioElement | null;

    // The INTERCEPTED retry loop and the COMPLETED handler can race to bind the
    // same element — a second bind would duplicate the element listeners
    if (targetAudio && this.audioPlayer === targetAudio) return;

    // The interceptor always produces a blob: URL. Refuse anything else, so a
    // page script squatting on our element id with an arbitrary remote src
    // can't get our player bound to it (defense-in-depth; see red-team notes)
    if (!targetAudio || !targetAudio.src || !targetAudio.src.startsWith('blob:')) {
      this.findAudioAttempts++;
      if (this.findAudioAttempts >= FIND_AUDIO_MAX_ATTEMPTS) {
        debugLog('[ChatGPT Read Aloud Controller]: Gave up waiting for audio element');
        this.handleAudioError('Timed out waiting for audio from OpenAI');
        return;
      }
      this.scheduleFindAudio(500);
      return;
    }

    debugLog('[ChatGPT Read Aloud Controller]: Binding to intercepted audio element');
    this.hijackAudioElement(targetAudio);
  }

  // Only one pending lookup at a time: a new schedule replaces any prior one,
  // so repeated messages (or the INTERCEPTED/COMPLETED pair) can never stack
  // concurrent retry loops
  private scheduleFindAudio(delayMs: number): void {
    if (this.findAudioTimeoutId !== null) clearTimeout(this.findAudioTimeoutId);
    this.findAudioTimeoutId = window.setTimeout(() => {
      this.findAudioTimeoutId = null;
      this.findAndBindInterceptedAudio();
    }, delayMs);
  }

  private hijackAudioElement(originalAudio: HTMLAudioElement): void {
    debugLog('[ChatGPT Read Aloud Controller]: Taking control of ChatGPT audio element');

    // Store reference to the original audio without modifying it
    this.audioPlayer = originalAudio;

    // Reset state for new audio
    this.currentState.hasError = false;
    this.currentState.errorMessage = '';
    this.currentState.isLoading = true;
    this.currentState.isStreaming = true;
    this.currentState.audioUrl = this.audioPlayer.src;
    this.currentState.volume = this.audioPlayer.volume;

    // Set up our event listeners WITHOUT disrupting the original element
    this.setupAudioEventsNonDestructive();

    // Enable our custom player (it should already be visible from the immediate show)
    if (this.playerUI?.classList.contains('disabled')) {
      this.showPlayer(); // This removes disabled state and keeps visible
    } else if (!this.playerUI?.classList.contains('visible')) {
      this.showPlayer(); // Fallback in case immediate show didn't work
    }
    this.updatePlayerContent();

    debugLog(
      '[ChatGPT Read Aloud Controller]: Monitoring audio element with src:',
      this.audioPlayer.src,
    );

    // The interceptor already started playback; if autoplay was blocked the
    // user can press play in our UI
  }

  private setupAudioEventsNonDestructive(): void {
    if (!this.audioPlayer) return;

    debugLog('[ChatGPT Read Aloud Controller]: Setting up non-destructive audio monitoring');

    // Capture the element these listeners belong to, so a handler firing after
    // a newer read-aloud has replaced the session can't act on the wrong state
    const boundAudio = this.audioPlayer;

    // Set up a polling mechanism to track audio state
    this.startAudioStatePolling();

    // Add minimal event listeners that won't conflict
    this.audioPlayer.addEventListener(
      'loadedmetadata',
      () => {
        if (this.audioPlayer !== boundAudio) return;
        const duration = this.audioPlayer!.duration;
        debugLog('[ChatGPT Read Aloud Controller]: Audio metadata loaded, duration:', duration);
        if (duration && isFinite(duration) && duration > 0) {
          this.currentState.duration = duration;
          this.currentState.isLoading = false;
          this.currentState.isStreaming = false;
          this.updateTimeDisplay();
          this.enableDurationDependentControls();
          debugLog('[ChatGPT Read Aloud Controller]: Audio fully loaded, duration:', duration);
        }
      },
      { passive: true },
    );

    this.audioPlayer.addEventListener(
      'ended',
      () => {
        if (this.audioPlayer !== boundAudio) return;
        this.currentState.isPlaying = false;
        this.updatePlayPauseButton();
        debugLog('[ChatGPT Read Aloud Controller]: Audio playback ended');
        // Auto-hide player when done — unless a newer read-aloud has started
        // in the meantime (stopAudio would revoke the new clip's blob)
        setTimeout(() => {
          if (this.audioPlayer === boundAudio) this.stopAudio();
        }, 1000);
      },
      { passive: true },
    );

    // Start monitoring immediately if metadata is already loaded and valid
    const duration = this.audioPlayer.duration;
    if (duration && isFinite(duration) && duration > 0) {
      this.currentState.duration = duration;
      this.currentState.isLoading = false;
      this.currentState.isStreaming = false;
      this.updateTimeDisplay();
      this.enableDurationDependentControls();
      debugLog('[ChatGPT Read Aloud Controller]: Initial duration set to:', duration);
    } else {
      debugLog('[ChatGPT Read Aloud Controller]: Initial duration not ready:', duration);
      this.currentState.isLoading = true;
      this.currentState.isStreaming = true;
    }

    // Update UI to show appropriate state
    this.updatePlayerContent();
  }

  private startAudioStatePolling(): void {
    // Only one polling loop at a time (a new read-aloud replaces the old audio)
    if (this.pollIntervalId !== null) {
      clearInterval(this.pollIntervalId);
    }
    // Poll audio state every 100ms to keep our UI in sync
    const pollInterval = window.setInterval(() => {
      if (!this.audioPlayer || !this.playerUI?.classList.contains('visible')) {
        clearInterval(pollInterval);
        if (this.pollIntervalId === pollInterval) this.pollIntervalId = null;
        return;
      }

      // Update current time and progress (with validation)
      const currentTime = this.audioPlayer.currentTime;
      if (isFinite(currentTime) && currentTime >= 0) {
        this.currentState.currentTime = currentTime;
        this.updateProgress();
        this.updateTimeDisplay();
      }

      // Update play/pause state
      const wasPlaying = this.currentState.isPlaying;
      this.currentState.isPlaying = !this.audioPlayer.paused;

      if (wasPlaying !== this.currentState.isPlaying) {
        this.updatePlayPauseButton();
        debugLog(
          '[ChatGPT Read Aloud Controller]: Audio state changed to:',
          this.currentState.isPlaying ? 'playing' : 'paused',
        );
      }

      // Update duration if it changes and becomes valid
      const duration = this.audioPlayer.duration;
      if (
        duration &&
        isFinite(duration) &&
        duration > 0 &&
        this.currentState.duration !== duration
      ) {
        debugLog(
          '[ChatGPT Read Aloud Controller]: Duration updated from',
          this.currentState.duration,
          'to',
          duration,
        );
        this.currentState.duration = duration;
        this.currentState.isLoading = false;
        this.currentState.isStreaming = false;
        this.updateTimeDisplay();
        this.updateProgress(); // Refresh progress with new duration
        this.updatePlayerContent(); // Update UI to hide loader
        this.enableDurationDependentControls();
      }
    }, 100);
    this.pollIntervalId = pollInterval;
  }

  private handleAudioError(errorMessage: string): void {
    this.currentState.hasError = true;
    this.currentState.errorMessage = errorMessage;
    this.updatePlayerContent();
  }

  private observeConversationChanges(): void {
    // Wait for document.body to be available
    if (!document.body) {
      debugLog(
        '[ChatGPT Read Aloud Controller]: Document body not ready for conversation observer, waiting...',
      );
      setTimeout(() => this.observeConversationChanges(), 100);
      return;
    }

    debugLog('[ChatGPT Read Aloud Controller]: Setting up conversation change observer');

    // Observer to detect conversation changes and close player — coalesced to
    // one check per animation frame so mutation storms (streaming, hydration)
    // don't run the URL check per batch
    const observer = new MutationObserver(() => {
      if (this.conversationScanQueued) return;
      this.conversationScanQueued = true;
      requestAnimationFrame(() => {
        this.conversationScanQueued = false;
        const newConversationId = this.extractConversationId();
        if (newConversationId && newConversationId !== this.currentConversationId) {
          debugLog('[ChatGPT Read Aloud Controller]: Conversation changed, closing player');
          this.stopAudio();
          this.currentConversationId = newConversationId;
        }
      });
    });

    try {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
      debugLog(
        '[ChatGPT Read Aloud Controller]: Conversation change observer started successfully',
      );
    } catch (error) {
      console.error(
        '[ChatGPT Read Aloud Controller]: Error setting up conversation observer:',
        error,
      );
    }
  }

  public updateCurrentConversationId(): void {
    this.currentConversationId = this.extractConversationId();
  }

  private extractConversationId(): string | null {
    // Extract conversation ID from URL
    const path = window.location.pathname;
    const match = path.match(/\/c\/([a-f0-9-]+)/);
    return match ? match[1] : null;
  }

  // ---------------------------------------------------------------------------
  // Inline "Listen" button
  //
  // ChatGPT moved its Read Aloud control into the "More actions" (⋯) dropdown,
  // so it takes two clicks to start playback. We inject a one-click "Listen"
  // button directly into each assistant turn's action bar. It works by driving
  // the native control: open the ⋯ menu, click the Read Aloud item, done. That
  // fires the /backend-api/synthesize request our interceptor already handles.
  // ---------------------------------------------------------------------------

  private observeAssistantTurns(): void {
    if (!document.body) {
      setTimeout(() => this.observeAssistantTurns(), 100);
      return;
    }

    // Coalesce mutation bursts into a single scan per animation frame so we
    // never run querySelectorAll on every mutation during ChatGPT's hydration.
    const observer = new MutationObserver(() => this.queueInlineButtonScan());
    observer.observe(document.body, { childList: true, subtree: true });
    this.scanForAssistantTurns();
    debugLog('[ChatGPT Read Aloud Controller]: Assistant-turn observer started');
  }

  private queueInlineButtonScan(): void {
    if (this.inlineButtonScanQueued) return;
    this.inlineButtonScanQueued = true;
    requestAnimationFrame(() => {
      this.inlineButtonScanQueued = false;
      this.scanForAssistantTurns();
    });
  }

  private scanForAssistantTurns(): void {
    const copyButtons = document.querySelectorAll(
      '[data-turn="assistant"] button[data-testid="copy-turn-action-button"]',
    );
    copyButtons.forEach((copyButton) => {
      const actionBar = copyButton.parentElement;
      if (!actionBar) return;
      if (actionBar.querySelector(`.${INLINE_BUTTON_CLASS}`)) return; // already injected
      const turn = copyButton.closest('[data-turn="assistant"]') as HTMLElement | null;
      if (!turn) return;
      this.injectInlineButton(actionBar, copyButton as HTMLElement, turn);
    });
  }

  private injectInlineButton(
    actionBar: HTMLElement,
    beforeButton: HTMLElement,
    turn: HTMLElement,
  ): void {
    const button = document.createElement('button');
    button.className = INLINE_BUTTON_CLASS;
    button.type = 'button';
    button.setAttribute('aria-label', 'Read aloud with controls');
    button.title = 'Read aloud with controls';
    button.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
      </svg>
      <span>Listen</span>
    `;
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.triggerReadAloudForTurn(turn);
    });
    actionBar.insertBefore(button, beforeButton);
  }

  private triggerReadAloudForTurn(turn: HTMLElement): void {
    // Already an inline control in the menu? Open it and click Read Aloud.
    const moreButton = [...turn.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'More actions',
    ) as HTMLButtonElement | undefined;

    if (!moreButton) {
      debugLog('[ChatGPT Read Aloud Controller]: No "More actions" button on this turn');
      return;
    }

    const openMenuAndClickReadAloud = (): void => {
      moreButton.click(); // opens the Radix dropdown

      // The menu item mounts asynchronously; poll briefly for it.
      let attempts = 0;
      const findAndClick = (): void => {
        const menuItem = document.querySelector(
          `[role="menuitem"]${VOICE_ACTION_SELECTOR.replace('button', '')}`,
        ) as HTMLElement | null;
        if (menuItem) {
          menuItem.click();
          // Close the menu (Radix leaves it open until focus/escape)
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          return;
        }
        if (++attempts >= 20) {
          debugLog('[ChatGPT Read Aloud Controller]: Read Aloud menu item never appeared');
          return;
        }
        setTimeout(findAndClick, 50);
      };
      setTimeout(findAndClick, 50);
    };

    // If some menu is already open — possibly another turn's — close it first,
    // so our click opens this turn's menu instead of toggling the wrong one
    if (document.querySelector('[role="menu"]')) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      setTimeout(openMenuAndClickReadAloud, 50);
    } else {
      openMenuAndClickReadAloud();
    }
  }

  private createPlayerUI(): void {
    // Check if player already exists in DOM
    const existingPlayer = document.getElementById('custom-chatgpt-audio-player');
    if (existingPlayer) {
      // Only adopt a node this extension created — a page script squatting on
      // our id would otherwise become our player UI (missing children would
      // then throw in the update methods). Replace anything foreign.
      if ((existingPlayer as HTMLElement).dataset.raOwned === 'true') {
        debugLog('[ChatGPT Read Aloud Controller]: Player UI already exists, using existing player');
        this.playerUI = existingPlayer;

        // Set up event listeners for the existing player
        this.setupPlayerEventListeners();

        // Initialize volume display
        this.updateVolumeDisplay();

        // Initialize speed selection
        this.setPlaybackSpeed(1.0);
        return;
      }
      existingPlayer.remove();
    }

    const player = document.createElement('div');
    player.id = 'custom-chatgpt-audio-player';
    player.dataset.raOwned = 'true';
    player.innerHTML = `
              <div class="player-container" role="region" aria-label="Audio Player Controls">
          <header class="player-header">
            <h2 class="player-title">ChatGPT Audio Player</h2>
            <div class="header-controls">
              <div class="speed-selector" role="group" aria-label="Playback speed selection">
                <button class="speed-button" aria-label="Select playback speed" aria-haspopup="true" aria-expanded="false">
                  <span class="speed-text" aria-hidden="true">1.0x</span>
                  <svg class="dropdown-arrow" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M7 10l5 5 5-5z"/>
                  </svg>
                </button>
                <ul class="speed-dropdown" role="listbox" aria-label="Playback speed options">
                  <li class="speed-option" role="option" data-speed="0.25" aria-selected="false" tabindex="0">
                    <span>0.25x</span>
                    <svg class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                    </svg>
                  </li>
                  <li class="speed-option" role="option" data-speed="0.5" aria-selected="false" tabindex="0">
                    <span>0.5x</span>
                    <svg class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                    </svg>
                  </li>
                  <li class="speed-option" role="option" data-speed="0.75" aria-selected="false" tabindex="0">
                    <span>0.75x</span>
                    <svg class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                    </svg>
                  </li>
                  <li class="speed-option selected" role="option" data-speed="1.0" aria-selected="true" tabindex="0">
                    <span>1.0x</span>
                    <svg class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                    </svg>
                  </li>
                  <li class="speed-option" role="option" data-speed="1.25" aria-selected="false" tabindex="0">
                    <span>1.25x</span>
                    <svg class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                    </svg>
                  </li>
                  <li class="speed-option" role="option" data-speed="1.5" aria-selected="false" tabindex="0">
                    <span>1.5x</span>
                    <svg class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                    </svg>
                  </li>
                  <li class="speed-option" role="option" data-speed="1.75" aria-selected="false" tabindex="0">
                    <span>1.75x</span>
                    <svg class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                    </svg>
                  </li>
                  <li class="speed-option" role="option" data-speed="2.0" aria-selected="false" tabindex="0">
                    <span>2.0x</span>
                    <svg class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                    </svg>
                  </li>
                </ul>
              </div>
              <button class="close-button" aria-label="Close audio player and stop playback">×</button>
            </div>
          </header>
          
          <main class="main-controls" role="group" aria-label="Playback controls">
            <button class="skip-button skip-backward" aria-label="Rewind 10 seconds" title="Rewind 10 seconds">
              <span aria-hidden="true">-10</span>
            </button>
            
            <button class="play-pause-button" aria-label="Play audio" aria-describedby="playback-status">
              <svg class="play-icon" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z"/>
              </svg>
              <svg class="pause-icon" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" style="display: none;" aria-hidden="true">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
              </svg>
            </button>
            
            <button class="skip-button skip-forward" aria-label="Fast forward 10 seconds" title="Fast forward 10 seconds">
              <span aria-hidden="true">+10</span>
            </button>
          </main>

          <section class="progress-container" role="group" aria-label="Audio progress">
            <div class="progress-bar" role="slider" aria-label="Audio progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0">
              <div class="progress-track">
                <div class="progress-fill"></div>
                <div class="progress-handle"></div>
              </div>
            </div>
            <div class="time-display" aria-live="polite">
              <time class="current-time" aria-label="Current time">0:00</time>
              <time class="total-time" aria-label="Total duration">Calculating...</time>
            </div>
            <div id="playback-status" class="sr-only" aria-live="polite"></div>
          </section>

          <section class="volume-container" role="group" aria-label="Volume controls">
            <button class="volume-button" aria-label="Toggle mute">
              <svg class="volume-on-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
              </svg>
              <svg class="volume-muted-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="display: none;" aria-hidden="true">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
              </svg>
            </button>
            <input type="range" class="volume-input" min="0" max="100" value="100" aria-label="Volume level" aria-describedby="volume-description">
            <div id="volume-description" class="sr-only">Use left and right arrow keys to adjust volume</div>
          </section>
          <div class="error-message" role="alert" style="display: none;" aria-live="assertive">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="color: #ef4444;" aria-hidden="true">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>
            <span class="error-text">Failed to load audio from OpenAI</span>
          </div>
          <div class="loading-indicator" style="display: none;" aria-live="polite">
            <span class="loading-spinner" aria-hidden="true"></span>
            <span class="loading-text">Loading audio from OpenAI…</span>
          </div>
          <div class="resize-handle" aria-hidden="true" title="Drag to resize"></div>
        </div>
      </div>
    `;

    // Add CSS styles
    const style = document.createElement('style');
    style.textContent = `
      #custom-chatgpt-audio-player {
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%) translateY(-10px);
        width: 300px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 16px;
        box-shadow: 0px 0 24px 4px rgba(0, 0, 0, 0.3);
        color: white;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        z-index: 10000;
        /* Only fade/slide the entry animation — left/top/width change instantly
           so dragging and resizing feel direct, not laggy. */
        transition: opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                    transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        backdrop-filter: blur(8px);
        opacity: 0;
        pointer-events: none;
      }

      #custom-chatgpt-audio-player.visible {
        transform: translateX(-50%) translateY(0);
        opacity: 1;
        width: 440px;
        pointer-events: auto;
      }

      /* Once the user has dragged/resized, position is explicit (inline left/top/
         width) and the centering transform must be dropped. */
      #custom-chatgpt-audio-player.positioned,
      #custom-chatgpt-audio-player.visible.positioned {
        transform: none;
      }

      .player-container {
        position: relative;
      }

      /* Header doubles as the drag handle */
      .player-header {
        cursor: grab;
        user-select: none;
      }

      #custom-chatgpt-audio-player.dragging .player-header {
        cursor: grabbing;
      }

      /* Interactive controls in the header shouldn't start a drag */
      .player-header .speed-selector,
      .player-header .close-button {
        cursor: pointer;
      }

      .resize-handle {
        position: absolute;
        right: 2px;
        bottom: 2px;
        width: 16px;
        height: 16px;
        cursor: nwse-resize;
        opacity: 0.5;
        transition: opacity 0.2s;
        background:
          linear-gradient(135deg, transparent 0 45%, rgba(255,255,255,0.6) 45% 55%, transparent 55% 100%),
          linear-gradient(135deg, transparent 0 70%, rgba(255,255,255,0.6) 70% 80%, transparent 80% 100%);
      }

      .resize-handle:hover {
        opacity: 1;
      }

      #custom-chatgpt-audio-player.disabled .resize-handle {
        opacity: 0.25;
        pointer-events: none;
      }

      .loading-indicator {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 10px 12px;
        color: #cbd5e1;
        font-size: 13px;
      }

      .loading-spinner {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255, 255, 255, 0.25);
        border-top-color: #10a37f;
        border-radius: 50%;
        animation: chatgpt-ra-spin 0.8s linear infinite;
        flex-shrink: 0;
      }

      @keyframes chatgpt-ra-spin {
        to { transform: rotate(360deg); }
      }

      /* Inline "Listen" button injected into each assistant turn's action bar */
      .${INLINE_BUTTON_CLASS} {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: transparent;
        border: none;
        color: inherit;
        cursor: pointer;
        border-radius: 6px;
        padding: 4px 6px;
        font-size: 12px;
        opacity: 0.75;
        transition: opacity 0.15s, background-color 0.15s;
      }

      .${INLINE_BUTTON_CLASS}:hover {
        opacity: 1;
        background: rgba(127, 127, 127, 0.15);
      }

      #custom-chatgpt-audio-player.disabled {
        pointer-events: none;
      }

      #custom-chatgpt-audio-player.disabled button,
      #custom-chatgpt-audio-player.disabled .progress-track,
      #custom-chatgpt-audio-player.disabled .volume-input,
      #custom-chatgpt-audio-player.disabled .speed-selector {
        opacity: 0.5;
        cursor: not-allowed;
        pointer-events: none;
      }

      #custom-chatgpt-audio-player.disabled .close-button {
        opacity: 1;
        cursor: pointer;
        pointer-events: auto;
      }

      .skip-button.no-duration,
      .speed-selector.no-duration {
        opacity: 0.5;
        cursor: not-allowed;
        pointer-events: none;
      }

      /* Focus ring styles for accessibility */
      button:focus-visible,
      input:focus-visible,
      .speed-selector:focus-within {
        outline: 2px solid #10a37f;
        outline-offset: 2px;
        box-shadow: 0 0 0 4px rgba(16, 163, 127, 0.2);
      }

      .play-pause-button:focus-visible {
        outline: 3px solid #10a37f;
        outline-offset: 3px;
        box-shadow: 0 0 0 6px rgba(16, 163, 127, 0.3);
      }

      /* Ensure focus is visible even when disabled */
      #custom-chatgpt-audio-player.disabled button:focus-visible {
        outline: 2px solid rgba(16, 163, 127, 0.7);
        outline-offset: 2px;
        box-shadow: 0 0 0 4px rgba(16, 163, 127, 0.15);
      }

      /* Screen reader only content */
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

      /* Remove default list styling for speed dropdown */
      .speed-dropdown {
        list-style: none;
        padding: 0;
        margin: 0;
      }

      /* Fix header and main styling for semantic elements */
      .player-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
      }

      .player-title {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        color: #fff;
      }


      .player-container {
        padding: 16px;
      }

      .player-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
      }

      .player-title {
        font-size: 14px;
        font-weight: 600;
        color: #fff;
      }

      .header-controls {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .speed-selector {
        position: relative;
        display: inline-block;
      }

      .speed-button {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: #fff;
        font-size: 12px;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 6px;
        transition: all 0.2s;
        font-weight: 500;
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .speed-button:hover {
        background: rgba(255, 255, 255, 0.2);
        color: #fff;
      }

      .dropdown-arrow {
        transition: transform 0.2s;
      }

      .speed-selector:hover .dropdown-arrow {
        transform: rotate(180deg);
      }

      .speed-dropdown {
        position: absolute;
        top: 100%;
        right: 0;
        margin-top: 4px;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        backdrop-filter: blur(8px);
        min-width: 80px;
        opacity: 0;
        visibility: hidden;
        transform: translateY(-10px);
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        z-index: 1000;
      }

      .speed-selector:hover .speed-dropdown {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
      }

      .speed-option {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        cursor: pointer;
        transition: background-color 0.2s;
        font-size: 12px;
        color: #fff;
      }

      .speed-option:hover {
        background: rgba(255, 255, 255, 0.1);
      }

      .speed-option.selected {
        background: rgba(255, 255, 255, 0.15);
      }

      .speed-option:first-child {
        border-radius: 8px 8px 0 0;
      }

      .speed-option:last-child {
        border-radius: 0 0 8px 8px;
      }

      .check-icon {
        opacity: 0;
        transition: opacity 0.2s;
      }

      .speed-option.selected .check-icon {
        opacity: 1;
      }

      .close-button {
        background: none;
        border: none;
        color: #999;
        font-size: 18px;
        cursor: pointer;
        padding: 4px 6px;
        border-radius: 4px;
        transition: color 0.2s;
      }

      .close-button:hover {
        color: #fff;
      }

      .main-controls {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 16px;
        margin-bottom: 16px;
      }

      .skip-button {
        border-radius: 8px;
        padding: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.2s;
        color: #fff;
        font-size: 12px;
        font-weight: bold;
      }

      .skip-button:hover {
        background: rgba(255, 255, 255, 0.2);
        color: #fff;
      }



      .play-pause-button {
        background: #10a37f;
        border: none;
        border-radius: 50%;
        width: 48px;
        height: 48px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.2s;
        flex-shrink: 0;
        color: #fff;
      }

      .play-pause-button:hover {
        background: #0d8a6b;
        transform: scale(1.05);
      }

      .play-pause-button.paused {
        border-radius: 12px;
        background: rgba(16, 163, 127, 0.8);
        border: 1px solid rgba(255, 255, 255, 0.3);
      }

      .progress-container {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .time-display {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: #999;
        margin-bottom: 4px;
      }

      .progress-bar {
        position: relative;
        height: 6px;
      }

      .progress-track {
        width: 100%;
        height: 6px;
        background: #333;
        border-radius: 3px;
        position: relative;
        cursor: pointer;
      }

      .progress-fill {
        height: 100%;
        background: #10b981;
        border-radius: 3px;
        width: 0%;
        transition: width 0.1s;
      }

      .progress-handle {
        position: absolute;
        top: 50%;
        left: 0%;
        width: 12px;
        height: 12px;
        background: #10b981;
        border-radius: 50%;
        transform: translate(-50%, -50%);
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.2s;
      }

      .progress-track:hover .progress-handle {
        opacity: 1;
      }

      .volume-container {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-inline: auto;
        width: 50%;
      }

      .volume-button {
        background: none;
        border: none;
        color: #999;
        cursor: pointer;
        padding: 4px;
        border-radius: 4px;
        transition: all 0.2s;
      }

      .volume-button:hover {
        background: #333;
        color: #fff;
      }

      .volume-slider-container {
        width: 60px;
      }

      .volume-input {
        width: 100%;
        height: 4px;
        background: rgba(255, 255, 255, 0.2);
        border-radius: 2px;
        outline: none;
        cursor: pointer;
        -webkit-appearance: none;
        appearance: none;
      }

      .volume-input::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 12px;
        height: 12px;
        background: #fff;
        border: 2px solid #10a37f;
        border-radius: 50%;
        cursor: pointer;
      }

      .volume-input::-moz-range-thumb {
        width: 12px;
        height: 12px;
        background: #fff;
        border: 2px solid #10a37f;
        border-radius: 50%;
        cursor: pointer;
      }

      .error-message {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px;
        background: #2d1b1b;
        border: 1px solid #553333;
        border-radius: 8px;
        color: #fca5a5;
        font-size: 14px;
        margin-top: 8px;
      }

      .error-message svg {
        flex-shrink: 0;
      }

      .player-content {
        display: flex;
        flex-direction: column;
      }
    `;

    document.head.appendChild(style);
    document.body.appendChild(player);
    this.playerUI = player;

    this.setupPlayerEventListeners();

    // Initialize volume display
    this.updateVolumeDisplay();

    // Initialize speed selection
    this.setPlaybackSpeed(1.0);
  }

  private updatePlayerContent(): void {
    if (!this.playerUI) return;

    const mainControls = this.playerUI.querySelector('.main-controls') as HTMLElement | null;
    const progressContainer = this.playerUI.querySelector('.progress-container') as HTMLElement | null;
    const volumeContainer = this.playerUI.querySelector('.volume-container') as HTMLElement | null;
    const errorMessage = this.playerUI.querySelector('.error-message') as HTMLElement | null;
    const loadingIndicator = this.playerUI.querySelector('.loading-indicator') as HTMLElement | null;

    // Loading is the window between the request and the audio being playable —
    // shown while the player is still in its disabled state or before duration
    // is known, so the user knows the (OpenAI-dependent) fetch is in progress.
    const isLoading =
      !this.currentState.hasError &&
      (this.playerUI.classList.contains('disabled') || this.currentState.isLoading);

    if (this.currentState.hasError) {
      // Show error, hide controls
      if (mainControls) mainControls.style.display = 'none';
      if (progressContainer) progressContainer.style.display = 'none';
      if (volumeContainer) volumeContainer.style.display = 'none';
      if (loadingIndicator) loadingIndicator.style.display = 'none';
      if (errorMessage) {
        errorMessage.style.display = 'flex';
        const errorText = errorMessage.querySelector('.error-text');
        if (errorText) {
          errorText.textContent = this.currentState.errorMessage || 'Audio playback failed';
        }
      }
    } else {
      // Show controls, hide error
      if (mainControls) mainControls.style.display = 'flex';
      if (progressContainer) progressContainer.style.display = 'block';
      if (volumeContainer) volumeContainer.style.display = 'flex';
      if (errorMessage) errorMessage.style.display = 'none';
      if (loadingIndicator) loadingIndicator.style.display = isLoading ? 'flex' : 'none';
    }
  }

  private setupPlayerEventListeners(): void {
    if (!this.playerUI) return;

    // Never bind twice (e.g. if init re-runs against an existing player node) —
    // duplicate handlers would double-fire close/play/drag actions
    if (this.playerUI.dataset.listenersBound) return;
    this.playerUI.dataset.listenersBound = 'true';

    // Close button
    const closeButton = this.playerUI.querySelector('.close-button');
    closeButton?.addEventListener('click', () => {
      this.stopAudio();
    });

    // Play/pause button
    const playPauseButton = this.playerUI.querySelector('.play-pause-button');
    playPauseButton?.addEventListener('click', () => {
      this.togglePlayPause();
    });

    // Skip backward button
    const skipBackward = this.playerUI.querySelector('.skip-backward');
    skipBackward?.addEventListener('click', () => {
      this.skipBackward();
    });

    // Skip forward button
    const skipForward = this.playerUI.querySelector('.skip-forward');
    skipForward?.addEventListener('click', () => {
      this.skipForward();
    });

    // Progress bar
    const progressTrack = this.playerUI.querySelector('.progress-track');
    progressTrack?.addEventListener('click', (e) => {
      this.seekAudio(e as MouseEvent);
    });

    // Volume button (toggle mute)
    const volumeButton = this.playerUI.querySelector('.volume-button');
    volumeButton?.addEventListener('click', () => {
      this.toggleMute();
    });

    // Volume input (native slider)
    const volumeInput = this.playerUI.querySelector('.volume-input') as HTMLInputElement;
    volumeInput?.addEventListener('input', (e) => {
      const volume = parseInt((e.target as HTMLInputElement).value) / 100;
      this.setVolume(volume);
    });

    // Speed options (new dropdown system)
    const speedOptions = this.playerUI.querySelectorAll('.speed-option');
    speedOptions.forEach((option) => {
      option.addEventListener('click', () => {
        const speed = parseFloat(option.getAttribute('data-speed') || '1.0');
        this.setPlaybackSpeed(speed);
      });
    });

    // Draggable / resizable window + restore any saved geometry
    this.makePlayerDraggable();
    this.makePlayerResizable();
    this.restorePlayerGeometry();
  }

  private makePlayerDraggable(): void {
    if (!this.playerUI) return;
    const header = this.playerUI.querySelector('.player-header') as HTMLElement | null;
    if (!header) return;

    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    const onMouseMove = (e: MouseEvent): void => {
      if (!this.playerUI) return;
      const left = startLeft + (e.clientX - startX);
      const top = startTop + (e.clientY - startY);
      // Keep the player within the viewport
      const rect = this.playerUI.getBoundingClientRect();
      const maxLeft = window.innerWidth - rect.width;
      const maxTop = window.innerHeight - rect.height;
      const clampedLeft = Math.max(0, Math.min(left, Math.max(0, maxLeft)));
      const clampedTop = Math.max(0, Math.min(top, Math.max(0, maxTop)));
      this.playerUI.style.left = `${clampedLeft}px`;
      this.playerUI.style.top = `${clampedTop}px`;
    };

    const onMouseUp = (): void => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      this.playerUI?.classList.remove('dragging');
      this.savePlayerGeometry();
    };

    header.addEventListener('mousedown', (e) => {
      const mouseEvent = e as MouseEvent;
      // Ignore drags that start on interactive header controls
      const target = mouseEvent.target as HTMLElement;
      if (target.closest('button, .speed-selector, input')) return;
      if (!this.playerUI || this.playerUI.classList.contains('disabled')) return;

      const rect = this.playerUI.getBoundingClientRect();
      // Switch from centering transform to explicit positioning on first drag
      this.playerUI.classList.add('positioned', 'dragging');
      this.playerUI.style.left = `${rect.left}px`;
      this.playerUI.style.top = `${rect.top}px`;
      startX = mouseEvent.clientX;
      startY = mouseEvent.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      mouseEvent.preventDefault();
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  private makePlayerResizable(): void {
    if (!this.playerUI) return;
    const handle = this.playerUI.querySelector('.resize-handle') as HTMLElement | null;
    if (!handle) return;

    let startX = 0;
    let startWidth = 0;

    const onMouseMove = (e: MouseEvent): void => {
      if (!this.playerUI) return;
      const width = startWidth + (e.clientX - startX);
      const clamped = Math.max(PLAYER_MIN_WIDTH, Math.min(width, PLAYER_MAX_WIDTH));
      this.playerUI.style.width = `${clamped}px`;
    };

    const onMouseUp = (): void => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      this.savePlayerGeometry();
    };

    handle.addEventListener('mousedown', (e) => {
      const mouseEvent = e as MouseEvent;
      if (!this.playerUI || this.playerUI.classList.contains('disabled')) return;
      const rect = this.playerUI.getBoundingClientRect();
      startX = mouseEvent.clientX;
      startWidth = rect.width;
      mouseEvent.preventDefault();
      mouseEvent.stopPropagation();
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  private savePlayerGeometry(): void {
    if (!this.playerUI) return;
    try {
      const geometry: PlayerGeometry = {};
      if (this.playerUI.classList.contains('positioned')) {
        geometry.left = parseFloat(this.playerUI.style.left) || 0;
        geometry.top = parseFloat(this.playerUI.style.top) || 0;
      }
      if (this.playerUI.style.width) {
        geometry.width = parseFloat(this.playerUI.style.width) || undefined;
      }
      localStorage.setItem(GEOMETRY_STORAGE_KEY, JSON.stringify(geometry));
    } catch {
      // localStorage may be unavailable (private mode, blocked); position just
      // won't persist, which is a harmless degradation.
    }
  }

  private restorePlayerGeometry(): void {
    if (!this.playerUI) return;
    let geometry: PlayerGeometry | null = null;
    try {
      const raw = localStorage.getItem(GEOMETRY_STORAGE_KEY);
      if (raw) geometry = JSON.parse(raw) as PlayerGeometry;
    } catch {
      geometry = null;
    }
    if (!geometry) return;

    if (Number.isFinite(geometry.width)) {
      const clamped = Math.max(PLAYER_MIN_WIDTH, Math.min(geometry.width!, PLAYER_MAX_WIDTH));
      this.playerUI.style.width = `${clamped}px`;
    }
    if (Number.isFinite(geometry.left) && Number.isFinite(geometry.top)) {
      // Clamp to the current viewport in case it shrank since last session
      const width = geometry.width || this.playerUI.getBoundingClientRect().width || 440;
      const left = Math.max(0, Math.min(geometry.left!, Math.max(0, window.innerWidth - width)));
      const top = Math.max(0, Math.min(geometry.top!, Math.max(0, window.innerHeight - 60)));
      this.playerUI.classList.add('positioned');
      this.playerUI.style.left = `${left}px`;
      this.playerUI.style.top = `${top}px`;
    }
  }

  private showPlayer(): void {
    if (this.playerUI) {
      this.playerUI.classList.add('visible');
      this.playerUI.classList.remove('hidden', 'disabled');
      debugLog('[ChatGPT Read Aloud Controller]: Showing player with animation');
      
      // Focus the play button for accessibility
      this.focusPlayButton();
    }
  }

  private showPlayerDisabled(): void {
    if (this.playerUI) {
      this.playerUI.classList.add('visible', 'disabled');
      this.playerUI.classList.remove('hidden');
      debugLog('[ChatGPT Read Aloud Controller]: Showing player disabled with animation');

      // Surface the loading indicator while we wait for the audio
      this.updatePlayerContent();

      // Focus the play button for accessibility (even when disabled)
      this.focusPlayButton();
    }
  }

  private focusPlayButton(): void {
    if (this.playerUI) {
      const playButton = this.playerUI.querySelector('.play-pause-button') as HTMLElement;
      if (playButton) {
        // Small delay to ensure animation has started
        setTimeout(() => {
          playButton.focus();
        }, 100);
      }
    }
  }

  private hidePlayer(): void {
    if (this.playerUI) {
      this.playerUI.classList.remove('visible');
      this.playerUI.classList.add('hidden');
      debugLog('[ChatGPT Read Aloud Controller]: Hiding player with animation');
    }
  }

  private togglePlayPause(): void {
    if (!this.audioPlayer) return;

    debugLog(
      '[ChatGPT Read Aloud Controller]: Toggling play/pause, current state:',
      this.currentState.isPlaying,
    );

    if (this.currentState.isPlaying) {
      this.audioPlayer.pause();
    } else {
      this.audioPlayer.play().catch((error) => {
        console.error('[ChatGPT Read Aloud Controller]: Error toggling play:', error);
      });
    }
  }

  private stopAudio(): void {
    debugLog('[ChatGPT Read Aloud Controller]: Stopping audio and resetting player');

    if (this.audioPlayer) {
      this.audioPlayer.pause();
      this.audioPlayer.currentTime = 0;
    }

    // Reset all state to empty
    this.resetPlayerState();

    this.updatePlayPauseButton();
    this.updateTimeDisplay();
    this.hidePlayer();

    this.cleanupAudioResources();
    this.pendingRequestId = null;
  }

  private resetPlayerState(): void {
    debugLog('[ChatGPT Read Aloud Controller]: Resetting player state to empty');
    this.currentState.isPlaying = false;
    this.currentState.currentTime = 0;
    this.currentState.duration = 0;
    this.currentState.volume = 1;
    this.currentState.hasError = false;
    this.currentState.errorMessage = '';
    this.currentState.isLoading = false;
    this.currentState.isStreaming = false;
    this.currentState.playbackRate = 1.0;
    this.currentState.isMuted = false;
  }

  private resetToInitialState(): void {
    debugLog('[ChatGPT Read Aloud Controller]: Resetting to initial state');
    
    // Stop any existing audio
    if (this.audioPlayer) {
      this.audioPlayer.pause();
      this.audioPlayer.currentTime = 0;
    }

    // Release the previous clip's object URL before a new read-aloud replaces
    // it — otherwise every back-to-back playback leaks a full audio blob
    this.cleanupAudioResources();

    // Reset all state
    this.resetPlayerState();

    // Reset UI elements to initial state
    if (this.playerUI) {
      // Ensure player is not in disabled state
      this.playerUI.classList.remove('disabled');

      // Reset time display
      const currentTimeElement = this.playerUI.querySelector('.current-time');
      const totalTimeElement = this.playerUI.querySelector('.total-time');
      if (currentTimeElement) currentTimeElement.textContent = '0:00';
      if (totalTimeElement) totalTimeElement.textContent = 'Calculating...';

      // Reset progress bar
      const progressFill = this.playerUI.querySelector('.progress-fill') as HTMLElement;
      const progressHandle = this.playerUI.querySelector('.progress-handle') as HTMLElement;
      if (progressFill) progressFill.style.width = '0%';
      if (progressHandle) progressHandle.style.left = '0%';

      // Reset play/pause button to play state
      this.updatePlayPauseButton();

      // Reset volume to 100%
      this.currentState.volume = 1.0;
      this.currentState.isMuted = false;
      this.updateVolumeDisplay();

      // Reset speed to 1.0x
      this.setPlaybackSpeed(1.0);

      // Disable duration-dependent controls
      this.disableDurationDependentControls();
    }

    // Clear any references
    this.audioPlayer = null;
    this.pendingRequestId = null;
  }

  private disableDurationDependentControls(): void {
    if (!this.playerUI) return;

    const skipButtons = this.playerUI.querySelectorAll('.skip-button');
    const speedSelector = this.playerUI.querySelector('.speed-selector');

    skipButtons.forEach(button => {
      button.classList.add('no-duration');
    });

    if (speedSelector) {
      speedSelector.classList.add('no-duration');
    }

    debugLog('[ChatGPT Read Aloud Controller]: Disabled duration-dependent controls');
  }

  private enableDurationDependentControls(): void {
    if (!this.playerUI) return;

    const skipButtons = this.playerUI.querySelectorAll('.skip-button');
    const speedSelector = this.playerUI.querySelector('.speed-selector');

    skipButtons.forEach(button => {
      button.classList.remove('no-duration');
    });

    if (speedSelector) {
      speedSelector.classList.remove('no-duration');
    }

    debugLog('[ChatGPT Read Aloud Controller]: Enabled duration-dependent controls');
  }

  private cleanupAudioResources(): void {
    // Clean up audio URL
    if (this.currentState.audioUrl) {
      URL.revokeObjectURL(this.currentState.audioUrl);
      this.currentState.audioUrl = null;
    }

    // Remove audio element
    if (this.audioPlayer) {
      this.audioPlayer.src = '';
      this.audioPlayer = null;
    }
  }

  private seekAudio(e: MouseEvent): void {
    if (!this.audioPlayer || !this.playerUI) return;

    // Check if duration is valid before seeking
    const duration = this.audioPlayer.duration;
    if (!duration || !isFinite(duration) || duration <= 0) {
      debugLog('[ChatGPT Read Aloud Controller]: Cannot seek - invalid duration:', duration);
      return;
    }

    const progressTrack = this.playerUI.querySelector('.progress-track') as HTMLElement;
    const rect = progressTrack.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, clickX / rect.width)); // Clamp between 0 and 1
    const newTime = percentage * duration;

    debugLog(
      '[ChatGPT Read Aloud Controller]: Seeking to:',
      newTime,
      'seconds (',
      Math.round(percentage * 100),
      '%)',
    );
    this.audioPlayer.currentTime = newTime;
  }

  private setVolume(volume: number): void {
    this.currentState.volume = volume;
    if (this.audioPlayer) {
      this.audioPlayer.volume = volume;
    }
  }

  private updateProgress(): void {
    if (!this.playerUI) return;

    // Only update progress if we have valid duration and current time
    const duration = this.currentState.duration;
    const currentTime = this.currentState.currentTime;

    if (!duration || !isFinite(duration) || duration <= 0 || !isFinite(currentTime)) {
      return;
    }

    const percentage = Math.max(0, Math.min(100, (currentTime / duration) * 100));
    const progressFill = this.playerUI.querySelector('.progress-fill') as HTMLElement;
    const progressHandle = this.playerUI.querySelector('.progress-handle') as HTMLElement;

    if (progressFill) {
      progressFill.style.width = `${percentage}%`;
    }
    if (progressHandle) {
      progressHandle.style.left = `${percentage}%`;
    }
  }

  private updateTimeDisplay(): void {
    if (!this.playerUI) return;

    const currentTimeElement = this.playerUI.querySelector('.current-time');
    const totalTimeElement = this.playerUI.querySelector('.total-time');

    const currentTime = this.currentState.currentTime;
    const duration = this.currentState.duration;

    if (currentTimeElement) {
      const displayTime = isFinite(currentTime) && currentTime >= 0 ? currentTime : 0;
      currentTimeElement.textContent = this.formatTime(displayTime);
    }

    if (totalTimeElement) {
      if (isFinite(duration) && duration > 0) {
        totalTimeElement.textContent = this.formatTime(duration);
      } else {
        totalTimeElement.textContent = 'Calculating...';
      }
    }
  }

  private updatePlayPauseButton(): void {
    if (!this.playerUI) return;

    const playIcon = this.playerUI.querySelector('.play-icon') as HTMLElement | null;
    const pauseIcon = this.playerUI.querySelector('.pause-icon') as HTMLElement | null;
    const playPauseButton = this.playerUI.querySelector('.play-pause-button') as HTMLElement | null;
    const playbackStatus = this.playerUI.querySelector('#playback-status') as HTMLElement | null;
    if (!playIcon || !pauseIcon || !playPauseButton) return;

    if (this.currentState.isPlaying) {
      playIcon.style.display = 'none';
      pauseIcon.style.display = 'block';
      playPauseButton.classList.remove('paused');
      playPauseButton.setAttribute('aria-label', 'Pause audio');
      
      // Update screen reader status
      if (playbackStatus) {
        playbackStatus.textContent = 'Audio is playing';
      }
    } else {
      playIcon.style.display = 'block';
      pauseIcon.style.display = 'none';
      playPauseButton.classList.add('paused');
      playPauseButton.setAttribute('aria-label', 'Play audio');
      
      // Update screen reader status
      if (playbackStatus) {
        playbackStatus.textContent = 'Audio is paused';
      }
    }
  }

  private updateVolumeDisplay(): void {
    if (!this.playerUI) return;

    const volumeOnIcon = this.playerUI.querySelector('.volume-on-icon') as HTMLElement | null;
    const volumeMutedIcon = this.playerUI.querySelector('.volume-muted-icon') as HTMLElement | null;
    const volumeInput = this.playerUI.querySelector('.volume-input') as HTMLInputElement | null;
    if (!volumeOnIcon || !volumeMutedIcon) return;

    if (this.currentState.isMuted) {
      volumeOnIcon.style.display = 'none';
      volumeMutedIcon.style.display = 'block';
      if (volumeInput) volumeInput.value = '0';
    } else {
      volumeOnIcon.style.display = 'block';
      volumeMutedIcon.style.display = 'none';
      const volumePercent = this.currentState.volume * 100;
      if (volumeInput) volumeInput.value = volumePercent.toString();
    }
  }

  private setPlaybackSpeed(speed: number): void {
    if (!this.audioPlayer || !this.playerUI) return;

    this.currentState.playbackRate = speed;
    this.audioPlayer.playbackRate = speed;

    // Update button text
    const speedText = this.playerUI.querySelector('.speed-text') as HTMLElement;
    if (speedText) {
      speedText.textContent = `${speed}x`;
    }

    // Update dropdown selection and ARIA attributes
    const speedOptions = this.playerUI.querySelectorAll('.speed-option');
    speedOptions.forEach((option) => {
      const optionSpeed = parseFloat(option.getAttribute('data-speed') || '1.0');
      if (optionSpeed === speed) {
        option.classList.add('selected');
        option.setAttribute('aria-selected', 'true');
      } else {
        option.classList.remove('selected');
        option.setAttribute('aria-selected', 'false');
      }
    });

    // Update speed button aria-label
    const speedButton = this.playerUI.querySelector('.speed-button') as HTMLElement;
    if (speedButton) {
      speedButton.setAttribute('aria-label', `Current speed: ${speed}x. Click to select different speed`);
    }

    debugLog('[ChatGPT Read Aloud Controller]: Playback speed set to:', speed);
  }

  private skipBackward(): void {
    if (!this.audioPlayer) return;

    const newTime = Math.max(0, this.audioPlayer.currentTime - 10);
    this.audioPlayer.currentTime = newTime;
    debugLog('[ChatGPT Read Aloud Controller]: Skipped backward 10 seconds to:', newTime);
  }

  private skipForward(): void {
    if (!this.audioPlayer) return;

    const maxTime = this.audioPlayer.duration || this.currentState.duration;
    const newTime = Math.min(maxTime, this.audioPlayer.currentTime + 10);
    this.audioPlayer.currentTime = newTime;
    debugLog('[ChatGPT Read Aloud Controller]: Skipped forward 10 seconds to:', newTime);
  }

  private toggleMute(): void {
    if (!this.audioPlayer || !this.playerUI) return;

    this.currentState.isMuted = !this.currentState.isMuted;
    this.audioPlayer.muted = this.currentState.isMuted;
    this.updateVolumeDisplay();
    debugLog('[ChatGPT Read Aloud Controller]: Toggled mute to:', this.currentState.isMuted);
  }

  private formatTime(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }
}

// Global controller instance to prevent duplicates
let controllerInstance: ChatGPTReadAloudController | null = null;

// Initialize the controller when the page loads
function initializeChatGPTReadAloudController(): void {
  // Check if we're on ChatGPT
  if (window.location.hostname === 'chatgpt.com') {
    // Only create one instance
    if (!controllerInstance) {
      debugLog('[ChatGPT Read Aloud Controller]: Initializing on ChatGPT');
      debugLog('[ChatGPT Read Aloud Controller]: Document ready state:', document.readyState);
      controllerInstance = new ChatGPTReadAloudController();
    } else {
      debugLog('[ChatGPT Read Aloud Controller]: Controller already exists, skipping initialization');
    }
  } else {
    debugLog(
      '[ChatGPT Read Aloud Controller]: Not on ChatGPT domain, current hostname:',
      window.location.hostname,
    );
  }
}

// Initialize based on document ready state
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeChatGPTReadAloudController);
} else {
  initializeChatGPTReadAloudController();
}

// Handle SPA navigation
let currentUrl = window.location.href;
function setupNavigationObserver() {
  if (!document.body) {
    setTimeout(setupNavigationObserver, 100);
    return;
  }

  new MutationObserver(() => {
    if (window.location.href !== currentUrl) {
      currentUrl = window.location.href;
      debugLog('[ChatGPT Read Aloud Controller]: URL changed to:', currentUrl);
      
      // Reset current conversation tracking when navigating
      if (controllerInstance) {
        controllerInstance.updateCurrentConversationId();
      }
      
      // Only initialize if we don't have a controller yet
      initializeChatGPTReadAloudController();
    }
  }).observe(document.body, { childList: true, subtree: true });
}

setupNavigationObserver();
