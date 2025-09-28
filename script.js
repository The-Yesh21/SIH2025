// --- DOM Elements ---
const urlInput = document.getElementById('youtubeUrl');
const loadButton = document.getElementById('loadVideoButton');
const playerContainer = document.getElementById('playerContainer');
const qualityButton = document.getElementById('qualityTestButton');
const qualityStatus = document.getElementById('qualityStatus');

let player; // This will hold the YouTube player object
let currentVideoId; // To store the ID of the current video
let lowBandwidthMode = false; // Toggle state for simulating low internet
let qualityRetryTimer = null; // Interval timer for enforcing low quality
let qualityRetryCount = 0; // Counter for retries

// A map to translate quality strings to human-readable text
const qualityMap = {
    'tiny': '144p',
    'small': '240p',
    'medium': '360p',
    'large': '480p',
    'hd720': '720p',
    'hd1080': '1080p',
    'highres': '1080p+'
};

// Quality precedence from lowest to highest
const QUALITY_ORDER = ['tiny', 'small', 'medium', 'large', 'hd720', 'hd1080', 'highres'];

// --- Main Functions ---

/**
 * Extracts the YouTube video ID from various URL formats.
 * @param {string} url - The YouTube URL.
 * @returns {string|null} - The video ID or null if not found.
 */
function getYouTubeID(url) {
    const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

/**
 * Creates the video facade (thumbnail + play button).
 * @param {string} videoId - The YouTube video ID.
 */
function createFacade(videoId) {
    playerContainer.innerHTML = `
        <div class="youtube-player-facade" style="background-image: url('https://img.youtube.com/vi/${videoId}/hqdefault.jpg');">
            <div class="play-button">▶</div>
        </div>
    `;
    
    playerContainer.querySelector('.youtube-player-facade').addEventListener('click', () => {
        loadYouTubeAPI(videoId);
    });
}

/**
 * Loads the YouTube IFrame API script dynamically.
 * @param {string} videoId - The video ID to play after loading.
 */
function loadYouTubeAPI(videoId) {
    if (window.YT && window.YT.Player) {
        createPlayer(videoId);
    } else {
        const tag = document.createElement('script');
        tag.src = "https://www.youtube.com/iframe_api";
        const firstScriptTag = document.getElementsByTagName('script')[0];
        firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

        window.onYouTubeIframeAPIReady = () => {
            createPlayer(videoId);
        };
    }
}

/**
 * Creates the YouTube player instance.
 * @param {string} videoId - The video ID to play.
 */
function createPlayer(videoId) {
    playerContainer.innerHTML = '<div id="player"></div>'; // Create a target for the player
    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        videoId: videoId,
        playerVars: {
            'autoplay': 1,
            'rel': 0, // Hide related videos
        },
        events: {
            'onReady': onPlayerReady,
            'onStateChange': onPlayerStateChange,
            'onPlaybackQualityChange': onPlayerQualityChange
        }
    });
}

/**
 * When the player is ready, if low-bandwidth mode is on, enforce low quality.
 */
function onPlayerReady() {
    if (lowBandwidthMode) {
        enforceLowQuality();
    }
}

/**
 * Handles player state changes, like showing the quality button when playing.
 * @param {object} event - The player state change event.
 */
function onPlayerStateChange(event) {
    if (event.data == YT.PlayerState.PLAYING) {
        // Show the quality test button once the video starts playing
        qualityButton.classList.remove('hidden');
        // If user enabled low-bandwidth before/while loading, enforce again when playback starts
        if (lowBandwidthMode) {
            enforceLowQuality();
        }
    }
}

/**
 * This runs whenever the video quality actually changes.
 * @param {object} event - The playback quality change event.
 */
function onPlayerQualityChange(event) {
    const newQuality = event.data;
    const readableQuality = qualityMap[newQuality] || 'Auto';
    qualityStatus.textContent = `Video quality changed to: ${readableQuality}`;
    // Stop retrying once we reach the target in low-bandwidth mode
    if (lowBandwidthMode && newQuality === 'small') {
        clearQualityRetry();
    }
}

/**
 * Try to force lower quality (240p). YouTube treats this as a suggestion,
 * so we retry a few times to increase the chance it stuck.
 */
function enforceLowQuality() {
    if (!player) return;
    clearQualityRetry();
    const target = getLowestAvailableQuality() || 'small';
    qualityStatus.textContent = `Requesting lower quality (${qualityMap[target] || target})...`;
    // Immediate attempt: set quality and also try a reload at current time with suggestedQuality
    try { player.setPlaybackQuality(target); } catch {}
    try {
        const t = safeGetCurrentTime();
        if (typeof t === 'number') {
            player.loadVideoById({ videoId: currentVideoId, startSeconds: t, suggestedQuality: target });
        }
    } catch {}
    // Kick playback in case it's paused/buffering
    try {
        player.playVideo();
    } catch {}
    // Retry up to N times
    qualityRetryCount = 0;
    qualityRetryTimer = setInterval(() => {
        qualityRetryCount++;
        const q = safeGetPlaybackQuality();
        const desired = getLowestAvailableQuality() || 'small';
        if (q === desired) {
            clearQualityRetry();
            return;
        }
        // Suggest again
        try { player.setPlaybackQuality(desired); } catch {}
        // Every few attempts, force reload at current position with suggestedQuality
        if (qualityRetryCount === 2 || qualityRetryCount === 5) {
            try {
                const t = safeGetCurrentTime();
                if (typeof t === 'number') {
                    player.loadVideoById({ videoId: currentVideoId, startSeconds: t, suggestedQuality: desired });
                }
            } catch {}
        }
        if (qualityRetryCount >= 10) {
            clearQualityRetry();
            const finalQ = safeGetPlaybackQuality();
            const msgQ = qualityMap[finalQ] || finalQ || 'Auto';
            qualityStatus.textContent = `Tried to lower quality; final setting is ${msgQ} and may vary due to YouTube auto.`;
        }
    }, 600);
}

function clearQualityRetry() {
    if (qualityRetryTimer) {
        clearInterval(qualityRetryTimer);
        qualityRetryTimer = null;
    }
}

function safeGetPlaybackQuality() {
    try {
        return player.getPlaybackQuality && player.getPlaybackQuality();
    } catch {
        return undefined;
    }
}

function safeGetAvailableQualityLevels() {
    try {
        return player.getAvailableQualityLevels && player.getAvailableQualityLevels();
    } catch {
        return undefined;
    }
}

function safeGetCurrentTime() {
    try {
        return player.getCurrentTime && player.getCurrentTime();
    } catch {
        return undefined;
    }
}

function getLowestAvailableQuality() {
    const levels = safeGetAvailableQualityLevels();
    if (!Array.isArray(levels) || levels.length === 0) return undefined;
    // Pick the lowest by our defined order
    for (const q of QUALITY_ORDER) {
        if (levels.includes(q)) return q;
    }
    // Fallback: if API returns unknown ordering, try the last item
    return levels[levels.length - 1];
}

// --- Event Listeners ---

loadButton.addEventListener('click', () => {
    const url = urlInput.value;
    const videoId = getYouTubeID(url);
    if (videoId) {
        currentVideoId = videoId;
        createFacade(videoId);
        qualityButton.classList.add('hidden'); // Hide button until video plays
        qualityStatus.textContent = ''; // Clear status on new video load
        // Reset toggle when new video is loaded (optional: keep state if desired)
        clearQualityRetry();
        lowBandwidthMode = false;
        qualityButton.textContent = 'Simulate Low Internet';
    } else {
        alert('Please enter a valid YouTube video link!');
    }
});

qualityButton.addEventListener('click', () => {
    // Run a purely visual simulation: show overlay animation and staged messages
    simulateLowInternetExperience();
});

/**
 * Show an animated overlay and staged, fake status messages to simulate low internet.
 */
function simulateLowInternetExperience() {
    // Ensure real enforcement is off
    lowBandwidthMode = false;
    clearQualityRetry();

    // Build overlay if not present
    createSimulateOverlay();
    qualityButton.disabled = true;
    const originalText = qualityButton.textContent;
    qualityButton.textContent = 'Simulating...';

    // Staged messages
    qualityStatus.textContent = 'Simulating low internet...';
    setTimeout(() => {
        qualityStatus.textContent = 'Diagnosing network...';
    }, 700);
    setTimeout(() => {
        qualityStatus.textContent = 'Bandwidth detected: 420 kbps (simulated)';
    }, 1400);
    setTimeout(() => {
        qualityStatus.textContent = 'Applying lower resolution: 240p (simulated)';
    }, 2100);
    setTimeout(() => {
        removeSimulateOverlay();
        qualityStatus.textContent = 'Video quality changed to: 240p (simulated)';
        qualityButton.disabled = false;
        qualityButton.textContent = originalText;
    }, 3000);
}

function createSimulateOverlay() {
    if (document.getElementById('simulateOverlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'simulateOverlay';
    overlay.className = 'simulate-overlay';
    overlay.innerHTML = `
        <div class="simulate-overlay-content">
            <div class="spinner"></div>
            <div class="simulate-text">Simulating low internet...</div>
        </div>
    `;
    playerContainer.appendChild(overlay);
}

function removeSimulateOverlay() {
    const overlay = document.getElementById('simulateOverlay');
    if (overlay) overlay.remove();
}