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
  type:
    | 'SYNTHESIZE_REQUEST_INTERCEPTED'
    | 'SYNTHESIZE_REQUEST_COMPLETED'
    | 'SYNTHESIZE_REQUEST_FAILED';
  requestId: string;
  url: string;
  statusCode?: number;
  error?: string;
}

class ChatGPTReadAloudController {
  private audioPlayer: HTMLAudioElement | null = null;
  private playerUI: HTMLElement | null = null;
  private currentAudioSrc: string | null = null;
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
  private chatGPTStopButton: HTMLButtonElement | null = null;
  private currentReadAloudButton: HTMLButtonElement | null = null;
  private currentConversationId: string | null = null;
  private pendingRequestId: string | null = null;

  constructor() {
    console.log('[ChatGPT Read Aloud Controller]: Initializing extension');
    console.log('[ChatGPT Read Aloud Controller]: Current URL:', window.location.href);
    this.setupMessageListener();
    this.observeReadAloudButtons();
    this.observeConversationChanges();
    this.createPlayerUI(); // Player is always present
    this.updateCurrentConversationId();
    console.log('[ChatGPT Read Aloud Controller]: Initialization complete');
  }

  private setupMessageListener(): void {
    // Listen for messages from background script
    console.log('[ChatGPT Read Aloud Controller]: Setting up message listener');
    chrome.runtime.onMessage.addListener((message: SynthesizeMessage, sender, sendResponse) => {
      console.log('[ChatGPT Read Aloud Controller]: Received message:', message);

      switch (message.type) {
        case 'SYNTHESIZE_REQUEST_INTERCEPTED':
          this.pendingRequestId = message.requestId;
          console.log(
            '[ChatGPT Read Aloud Controller]: Starting to look for ChatGPT audio element',
          );
          // Wait a bit for ChatGPT to create their audio element, then hijack it
          setTimeout(() => {
            this.findAndHijackChatGPTAudio();
          }, 500);
          break;

        case 'SYNTHESIZE_REQUEST_COMPLETED':
          if (message.requestId === this.pendingRequestId) {
            console.log('[ChatGPT Read Aloud Controller]: Synthesis completed, looking for audio');
            // Try again to find the audio element
            setTimeout(() => {
              this.findAndHijackChatGPTAudio();
            }, 200);
          }
          break;

        case 'SYNTHESIZE_REQUEST_FAILED':
          if (message.requestId === this.pendingRequestId) {
            this.handleAudioError(`Request failed: ${message.error || 'Unknown error'}`);
          }
          break;
      }

      sendResponse({ received: true });
      return true;
    });
  }

  private findAndHijackChatGPTAudio(): void {
    // Look for ChatGPT's audio elements
    const audioElements = document.querySelectorAll('audio');
    console.log(`[ChatGPT Read Aloud Controller]: Found ${audioElements.length} audio elements`);

    // Find the most recently created audio element (likely the one for read-aloud)
    let targetAudio: HTMLAudioElement | null = null;
    audioElements.forEach((audio) => {
      if (audio.src && (audio.src.includes('synthesize') || audio.src.includes('blob:'))) {
        targetAudio = audio;
        console.log(
          '[ChatGPT Read Aloud Controller]: Found potential ChatGPT audio element:',
          audio.src,
        );
      }
    });

    if (!targetAudio) {
      console.log(
        '[ChatGPT Read Aloud Controller]: No ChatGPT audio element found yet, retrying...',
      );
      // Retry after a short delay
      setTimeout(() => {
        this.findAndHijackChatGPTAudio();
      }, 500);
      return;
    }

    console.log('[ChatGPT Read Aloud Controller]: Hijacking ChatGPT audio element');
    this.hijackAudioElement(targetAudio);
  }

  private hijackAudioElement(originalAudio: HTMLAudioElement): void {
    console.log('[ChatGPT Read Aloud Controller]: Taking control of ChatGPT audio element');

    // Store reference to the original audio without modifying it
    this.audioPlayer = originalAudio;
    this.currentAudioSrc = originalAudio.src || originalAudio.currentSrc;

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
    this.disableChatGPTStopButton();
    this.updatePlayerContent();

    console.log(
      '[ChatGPT Read Aloud Controller]: Monitoring audio element with src:',
      this.audioPlayer.src,
    );

    // Don't interfere with ChatGPT's playback - just monitor it
    // The audio should already be playing via ChatGPT's mechanism
  }

  private setupAudioEventsNonDestructive(): void {
    if (!this.audioPlayer) return;

    console.log('[ChatGPT Read Aloud Controller]: Setting up non-destructive audio monitoring');

    // Monitor the audio element without disrupting ChatGPT's listeners
    const originalSrc = this.audioPlayer.src;

    // Set up a polling mechanism to track audio state
    this.startAudioStatePolling();

    // Add minimal event listeners that won't conflict
    this.audioPlayer.addEventListener(
      'loadedmetadata',
      () => {
        const duration = this.audioPlayer!.duration;
        console.log('[ChatGPT Read Aloud Controller]: Audio metadata loaded, duration:', duration);
        if (duration && isFinite(duration) && duration > 0) {
          this.currentState.duration = duration;
          this.currentState.isLoading = false;
          this.currentState.isStreaming = false;
          this.updateTimeDisplay();
          this.enableDurationDependentControls();
          console.log('[ChatGPT Read Aloud Controller]: Audio fully loaded, duration:', duration);
        }
      },
      { passive: true },
    );

    this.audioPlayer.addEventListener(
      'ended',
      () => {
        this.currentState.isPlaying = false;
        this.updatePlayPauseButton();
        console.log('[ChatGPT Read Aloud Controller]: Audio playback ended');
        // Auto-hide player when done
        setTimeout(() => {
          this.stopAudio();
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
      console.log('[ChatGPT Read Aloud Controller]: Initial duration set to:', duration);
    } else {
      console.log('[ChatGPT Read Aloud Controller]: Initial duration not ready:', duration);
      this.currentState.isLoading = true;
      this.currentState.isStreaming = true;
    }

    // Update UI to show appropriate state
    this.updatePlayerContent();
  }

  private startAudioStatePolling(): void {
    // Poll audio state every 100ms to keep our UI in sync
    const pollInterval = setInterval(() => {
      if (!this.audioPlayer || !this.playerUI?.classList.contains('visible')) {
        clearInterval(pollInterval);
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
        console.log(
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
        console.log(
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
  }

  private handleAudioError(errorMessage: string): void {
    this.currentState.hasError = true;
    this.currentState.errorMessage = errorMessage;
    this.updatePlayerContent();
    // Don't disable ChatGPT's stop button on error
    this.enableChatGPTStopButton();
  }

  private observeConversationChanges(): void {
    // Wait for document.body to be available
    if (!document.body) {
      console.log(
        '[ChatGPT Read Aloud Controller]: Document body not ready for conversation observer, waiting...',
      );
      setTimeout(() => this.observeConversationChanges(), 100);
      return;
    }

    console.log('[ChatGPT Read Aloud Controller]: Setting up conversation change observer');

    // Observer to detect conversation changes and close player
    const observer = new MutationObserver(() => {
      const newConversationId = this.extractConversationId();
      if (newConversationId && newConversationId !== this.currentConversationId) {
        console.log('[ChatGPT Read Aloud Controller]: Conversation changed, closing player');
        this.stopAudio();
        this.currentConversationId = newConversationId;
      }
    });

    try {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
      console.log(
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

  private observeReadAloudButtons(): void {
    // Wait for document.body to be available
    if (!document.body) {
      console.log('[ChatGPT Read Aloud Controller]: Document body not ready, waiting...');
      setTimeout(() => this.observeReadAloudButtons(), 100);
      return;
    }

    console.log(
      '[ChatGPT Read Aloud Controller]: Setting up MutationObserver for read-aloud buttons',
    );

    // Observer to watch for new read-aloud buttons
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as Element;
            // Look for read-aloud buttons in assistant messages
            const readAloudButtons = element.querySelectorAll(
              'article[data-turn="assistant"] button[data-testid="voice-play-turn-action-button"]',
            );

            readAloudButtons.forEach((button) => {
              this.setupReadAloudButtonListener(button as HTMLButtonElement);
            });
          }
        });
      });
    });

    try {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
      console.log('[ChatGPT Read Aloud Controller]: MutationObserver started successfully');
    } catch (error) {
      console.error('[ChatGPT Read Aloud Controller]: Error setting up MutationObserver:', error);
    }

    // Also check for existing buttons
    this.setupExistingReadAloudButtons();
  }

  private setupExistingReadAloudButtons(): void {
    const existingButtons = document.querySelectorAll(
      'article[data-turn="assistant"] button[data-testid="voice-play-turn-action-button"]',
    );

    console.log(
      '[ChatGPT Read Aloud Controller]: Found existing read-aloud buttons:',
      existingButtons.length,
    );

    existingButtons.forEach((button, index) => {
      console.log(`[ChatGPT Read Aloud Controller]: Setting up listener for button ${index + 1}`);
      this.setupReadAloudButtonListener(button as HTMLButtonElement);
    });
  }

  private setupReadAloudButtonListener(button: HTMLButtonElement): void {
    // Don't add listener if already added
    if (button.dataset.customListenerAdded) {
      console.log('[ChatGPT Read Aloud Controller]: Button already has listener, skipping');
      return;
    }

    console.log('[ChatGPT Read Aloud Controller]: Adding click listener to read-aloud button');
    button.addEventListener('click', () => {
      console.log('[ChatGPT Read Aloud Controller]: Read aloud button clicked!');

      // Store reference to the current read-aloud button
      this.currentReadAloudButton = button;
      console.log('[ChatGPT Read Aloud Controller]: Stored read-aloud button reference:', button);
      console.log('[ChatGPT Read Aloud Controller]: Button data-testid:', button.getAttribute('data-testid'));

      // Reset player to initial state
      this.resetToInitialState();

      // Show player immediately but disabled
      this.showPlayerDisabled();

      // Store reference to the button that will become the stop button after a short delay
      setTimeout(() => {
        this.findAndStoreChatGPTStopButton();
        // Disable the button once it becomes the stop button
        this.disableNativeReadAloudButton();
      }, 200);
    });

    button.dataset.customListenerAdded = 'true';
    console.log('[ChatGPT Read Aloud Controller]: Click listener added successfully');
  }

  private findAndStoreChatGPTStopButton(): void {
    // Look for the stop button (will have different aria-label after transformation)
    const stopButton = document.querySelector(
      'article[data-turn="assistant"] button[data-testid="voice-play-turn-action-button"][aria-label="Stop"]',
    ) as HTMLButtonElement;

    if (stopButton) {
      this.chatGPTStopButton = stopButton;
      // Also update our currentReadAloudButton reference to point to the stop button
      this.currentReadAloudButton = stopButton;
      console.debug('[ChatGPT Read Aloud Controller]: Found ChatGPT stop button and updated reference');
    }
  }

  private disableChatGPTStopButton(): void {
    if (this.chatGPTStopButton) {
      this.chatGPTStopButton.style.pointerEvents = 'none';
      this.chatGPTStopButton.style.opacity = '0.5';
      this.chatGPTStopButton.style.cursor = 'not-allowed';
    }
  }

  private enableChatGPTStopButton(): void {
    if (this.chatGPTStopButton) {
      this.chatGPTStopButton.style.pointerEvents = '';
      this.chatGPTStopButton.style.opacity = '';
      this.chatGPTStopButton.style.cursor = '';
    }
  }

  private disableNativeReadAloudButton(): void {
    console.log('[ChatGPT Read Aloud Controller]: Attempting to disable native read-aloud button', this.currentReadAloudButton);
    if (this.currentReadAloudButton) {
      // Try both methods to ensure it works
      this.currentReadAloudButton.disabled = true;
      this.currentReadAloudButton.setAttribute('disabled', 'true');
      
      console.log('[ChatGPT Read Aloud Controller]: Disabled native read-aloud button - disabled property:', this.currentReadAloudButton.disabled);
      console.log('[ChatGPT Read Aloud Controller]: Disabled native read-aloud button - disabled attribute:', this.currentReadAloudButton.getAttribute('disabled'));
      console.log('[ChatGPT Read Aloud Controller]: Button element:', this.currentReadAloudButton);
      console.log('[ChatGPT Read Aloud Controller]: Button data-testid:', this.currentReadAloudButton.getAttribute('data-testid'));
      console.log('[ChatGPT Read Aloud Controller]: Button is still in DOM:', document.contains(this.currentReadAloudButton));
    } else {
      console.log('[ChatGPT Read Aloud Controller]: No currentReadAloudButton reference found');
    }
  }

  private enableNativeReadAloudButton(): void {
    if (this.currentReadAloudButton) {
      this.currentReadAloudButton.disabled = false;
      this.currentReadAloudButton.removeAttribute('disabled');
      console.log('[ChatGPT Read Aloud Controller]: Enabled native read-aloud button');
    }
  }

  private clearReadAloudButtonReferences(): void {
    // Find all read-aloud buttons and remove the custom listener flag
    // so they can be re-used for the same audio
    const readAloudButtons = document.querySelectorAll(
      'article[data-turn="assistant"] button[data-testid="voice-play-turn-action-button"]'
    );
    
    readAloudButtons.forEach((button) => {
      const buttonElement = button as HTMLButtonElement;
      if (buttonElement.dataset.customListenerAdded) {
        delete buttonElement.dataset.customListenerAdded;
        console.log('[ChatGPT Read Aloud Controller]: Cleared listener flag from read-aloud button');
      }
    });

    // Also clear our current button references
    this.chatGPTStopButton = null;
    this.currentReadAloudButton = null;
    console.log('[ChatGPT Read Aloud Controller]: Cleared button references for re-use');
  }

  private createPlayerUI(): void {
    // Check if player already exists in DOM
    const existingPlayer = document.getElementById('custom-chatgpt-audio-player');
    if (existingPlayer) {
      console.log('[ChatGPT Read Aloud Controller]: Player UI already exists, using existing player');
      this.playerUI = existingPlayer;
      
      // Set up event listeners for the existing player
      this.setupPlayerEventListeners();
      
      // Initialize volume display
      this.updateVolumeDisplay();
      
      // Initialize speed selection
      this.setPlaybackSpeed(1.0);
      return;
    }

    const player = document.createElement('div');
    player.id = 'custom-chatgpt-audio-player';
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
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        backdrop-filter: blur(8px);
        opacity: 0;
        pointer-events: none;
      }

      #custom-chatgpt-audio-player.visible {
        transform: translateX(-50%) translateY(0);
        opacity: 1;
        width: 500px;
        pointer-events: auto;
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

      /* Style for disabled native ChatGPT read-aloud button */
      button[data-testid="voice-play-turn-action-button"][disabled] {
        background-color: rgba(255, 255, 255, 0.15) !important;
        opacity: 0.6 !important;
        cursor: not-allowed !important;
        pointer-events: none !important;
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

    const mainControls = this.playerUI.querySelector('.main-controls');
    const progressContainer = this.playerUI.querySelector('.progress-container');
    const volumeContainer = this.playerUI.querySelector('.volume-container');
    const errorMessage = this.playerUI.querySelector('.error-message');

    if (this.currentState.hasError) {
      // Show error, hide controls
      if (mainControls) mainControls.style.display = 'none';
      if (progressContainer) progressContainer.style.display = 'none';
      if (volumeContainer) volumeContainer.style.display = 'none';
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
    }
  }

  private setupPlayerEventListeners(): void {
    if (!this.playerUI) return;

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
  }

  private loadAudio(audioUrl: string): void {
    // This method is now handled by hijackAudioElement
    // Keep it for compatibility but delegate to the hijacking approach
    console.log('[ChatGPT Read Aloud Controller]: loadAudio called with URL:', audioUrl);
  }

  private showPlayer(): void {
    if (this.playerUI) {
      this.playerUI.classList.add('visible');
      this.playerUI.classList.remove('hidden', 'disabled');
      console.log('[ChatGPT Read Aloud Controller]: Showing player with animation');
      
      // Focus the play button for accessibility
      this.focusPlayButton();
    }
  }

  private showPlayerDisabled(): void {
    if (this.playerUI) {
      this.playerUI.classList.add('visible', 'disabled');
      this.playerUI.classList.remove('hidden');
      console.log('[ChatGPT Read Aloud Controller]: Showing player disabled with animation');
      
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
      console.log('[ChatGPT Read Aloud Controller]: Hiding player with animation');
    }
  }

  private togglePlayPause(): void {
    if (!this.audioPlayer) return;

    console.log(
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
    console.log('[ChatGPT Read Aloud Controller]: Stopping audio and resetting player');

    if (this.audioPlayer) {
      this.audioPlayer.pause();
      this.audioPlayer.currentTime = 0;
    }

    // Click ChatGPT's stop button to properly stop their audio
    this.clickChatGPTStopButton();

    // Reset all state to empty
    this.resetPlayerState();

    this.updatePlayPauseButton();
    this.updateTimeDisplay();
    this.hidePlayer();
    this.enableChatGPTStopButton();
    
    // Re-enable the native read-aloud button
    this.enableNativeReadAloudButton();

    // Clean disconnect: just stop our audio, let ChatGPT handle its own state
    this.cleanupAudioResources();
    this.pendingRequestId = null;

    // Clear read-aloud button references so they can be re-used
    this.clearReadAloudButtonReferences();
  }

  private resetPlayerState(): void {
    console.log('[ChatGPT Read Aloud Controller]: Resetting player state to empty');
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
    this.currentAudioSrc = null;
  }

  private resetToInitialState(): void {
    console.log('[ChatGPT Read Aloud Controller]: Resetting to initial state');
    
    // Stop any existing audio
    if (this.audioPlayer) {
      this.audioPlayer.pause();
      this.audioPlayer.currentTime = 0;
    }

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
      if (progressHandle) progressHandle.style.right = '100%';

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
    this.chatGPTStopButton = null;
    this.currentReadAloudButton = null;
    this.pendingRequestId = null;

    // Re-enable ChatGPT controls
    this.enableChatGPTStopButton();
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

    console.log('[ChatGPT Read Aloud Controller]: Disabled duration-dependent controls');
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

    console.log('[ChatGPT Read Aloud Controller]: Enabled duration-dependent controls');
  }

  private clickChatGPTStopButton(): void {
    if (this.chatGPTStopButton) {
      console.log('[ChatGPT Read Aloud Controller]: Clicking ChatGPT stop button');
      this.chatGPTStopButton.click();
    }
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
      console.log('[ChatGPT Read Aloud Controller]: Cannot seek - invalid duration:', duration);
      return;
    }

    const progressTrack = this.playerUI.querySelector('.progress-track') as HTMLElement;
    const rect = progressTrack.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, clickX / rect.width)); // Clamp between 0 and 1
    const newTime = percentage * duration;

    console.log(
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

    const playIcon = this.playerUI.querySelector('.play-icon') as HTMLElement;
    const pauseIcon = this.playerUI.querySelector('.pause-icon') as HTMLElement;
    const playPauseButton = this.playerUI.querySelector('.play-pause-button') as HTMLElement;
    const playbackStatus = this.playerUI.querySelector('#playback-status') as HTMLElement;

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

    const volumeOnIcon = this.playerUI.querySelector('.volume-on-icon') as HTMLElement;
    const volumeMutedIcon = this.playerUI.querySelector('.volume-muted-icon') as HTMLElement;
    const volumeInput = this.playerUI.querySelector('.volume-input') as HTMLInputElement;

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

    console.log('[ChatGPT Read Aloud Controller]: Playback speed set to:', speed);
  }

  private skipBackward(): void {
    if (!this.audioPlayer) return;

    const newTime = Math.max(0, this.audioPlayer.currentTime - 10);
    this.audioPlayer.currentTime = newTime;
    console.log('[ChatGPT Read Aloud Controller]: Skipped backward 10 seconds to:', newTime);
  }

  private skipForward(): void {
    if (!this.audioPlayer) return;

    const maxTime = this.audioPlayer.duration || this.currentState.duration;
    const newTime = Math.min(maxTime, this.audioPlayer.currentTime + 10);
    this.audioPlayer.currentTime = newTime;
    console.log('[ChatGPT Read Aloud Controller]: Skipped forward 10 seconds to:', newTime);
  }

  private toggleMute(): void {
    if (!this.audioPlayer || !this.playerUI) return;

    this.currentState.isMuted = !this.currentState.isMuted;
    this.audioPlayer.muted = this.currentState.isMuted;
    this.updateVolumeDisplay();
    console.log('[ChatGPT Read Aloud Controller]: Toggled mute to:', this.currentState.isMuted);
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
      console.log('[ChatGPT Read Aloud Controller]: Initializing on ChatGPT');
      console.log('[ChatGPT Read Aloud Controller]: Document ready state:', document.readyState);
      controllerInstance = new ChatGPTReadAloudController();
    } else {
      console.log('[ChatGPT Read Aloud Controller]: Controller already exists, skipping initialization');
    }
  } else {
    console.log(
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
      console.log('[ChatGPT Read Aloud Controller]: URL changed to:', currentUrl);
      
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
