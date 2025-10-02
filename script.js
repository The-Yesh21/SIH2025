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
let qualityMonitorTimer = null; // Polling timer to reflect applied quality in UI
let lastPlaybackTime = 0; // Last known playback time to support resume
let pauseDestroyTimer = null; // Debounce timer to avoid destroying on brief pauses

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
function createFacade(videoId, startSeconds = 0) {
    playerContainer.innerHTML = `
        <div class="youtube-player-facade" style="background-image: url('https://img.youtube.com/vi/${videoId}/hqdefault.jpg');">
            <div class="play-button">▶</div>
        </div>
    `;
    const facade = playerContainer.querySelector('.youtube-player-facade');
    facade.addEventListener('click', () => {
        loadYouTubeAPI(videoId, startSeconds);
    });
}

/**
 * Loads the YouTube IFrame API script dynamically.
 * @param {string} videoId - The video ID to play after loading.
 */
function loadYouTubeAPI(videoId, startSeconds = 0) {
    if (window.YT && window.YT.Player) {
        createPlayer(videoId, startSeconds);
    } else {
        const tag = document.createElement('script');
        tag.src = "https://www.youtube.com/iframe_api";
        const firstScriptTag = document.getElementsByTagName('script')[0];
        firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

        window.onYouTubeIframeAPIReady = () => {
            createPlayer(videoId, startSeconds);
        };
    }
}

/**
 * Creates the YouTube player instance.
 * @param {string} videoId - The video ID to play.
 */
function createPlayer(videoId, startSeconds = 0) {
    playerContainer.innerHTML = '<div id="player"></div>'; // Create a target for the player
    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        videoId: videoId,
        playerVars: {
            'autoplay': 1,
            'rel': 0, // Hide related videos
            'playsinline': 1,
            'modestbranding': 1,
            'start': Math.max(0, Math.floor(startSeconds || 0))
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
        // Try to start at a lower quality to reduce initial buffering
        const target = getLowestAvailableQuality() || 'small';
        try { player.pauseVideo(); } catch {}
        try { player.setPlaybackQuality(target); } catch {}
        // Small defer to let the player apply the quality hint
        setTimeout(() => {
            try { player.playVideo(); } catch {}
            enforceLowQuality();
            startQualityMonitor();
        }, 150);
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
        removePauseOverlay();
        if (pauseDestroyTimer) { clearTimeout(pauseDestroyTimer); pauseDestroyTimer = null; }
    } else if (
        event.data === YT.PlayerState.PAUSED ||
        event.data === YT.PlayerState.ENDED ||
        event.data === YT.PlayerState.CUED
    ) {
        // Debounce: wait a moment to ensure it's a user pause, not a brief buffer
        if (pauseDestroyTimer) clearTimeout(pauseDestroyTimer);
        pauseDestroyTimer = setTimeout(() => {
            try { lastPlaybackTime = safeGetCurrentTime() || lastPlaybackTime || 0; } catch {}
            // If ended, resume from 0
            if (event.data === YT.PlayerState.ENDED) lastPlaybackTime = 0;
            // Destroy player to avoid recommendations network usage and revert to facade
            try { player && player.destroy && player.destroy(); } catch {}
            player = null;
            createFacade(currentVideoId, lastPlaybackTime);
            // Also keep the simulate button visible
            qualityButton.classList.remove('hidden');
            // Clear monitors/timers related to quality enforcement while no player
            clearQualityRetry();
            clearQualityMonitor();
        }, 350);
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
    if (lowBandwidthMode) {
        const desired = getLowestAvailableQuality() || 'small';
        if (newQuality === desired) {
            clearQualityRetry();
        }
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
    // Suggest once, then a few gentle retries without reloading
    try { player.setPlaybackQuality(target); } catch {}
    try { player.playVideo(); } catch {}
    qualityRetryCount = 0;
    qualityRetryTimer = setInterval(() => {
        qualityRetryCount++;
        const q = safeGetPlaybackQuality();
        const desired = getLowestAvailableQuality() || 'small';
        if (q === desired) {
            clearQualityRetry();
            return;
        }
        // Light suggestion, no reload
        try { player.setPlaybackQuality(desired); } catch {}
        if (qualityRetryCount >= 5) {
            clearQualityRetry();
            const finalQ = safeGetPlaybackQuality();
            const msgQ = qualityMap[finalQ] || finalQ || 'Auto';
            qualityStatus.textContent = `Targeted ${qualityMap[desired] || desired}; actual is ${msgQ} (YouTube may adapt).`;
        }
    }, 1200);
}

/**
 * Toggle low-internet mode. When ON, repeatedly tries to lock to the lowest
 * available quality. When OFF, returns playback to automatic quality.
 */
function toggleLowInternetMode() {
    if (!lowBandwidthMode) {
        lowBandwidthMode = true;
        qualityButton.textContent = 'Disable Low Internet';
        if (player) {
            const target = getLowestAvailableQuality() || 'small';
            qualityStatus.textContent = `Low-internet mode ON. Targeting ${qualityMap[target] || target}.`;
            enforceLowQuality();
            startQualityMonitor();
        } else {
            qualityStatus.textContent = 'Low-internet mode ON. Will apply on playback.';
        }
    } else {
        lowBandwidthMode = false;
        clearQualityRetry();
        clearQualityMonitor();
        try { player && player.setPlaybackQuality('default'); } catch {}
        qualityButton.textContent = 'Simulate Low Internet';
        if (player) {
            const q = safeGetPlaybackQuality();
            const readable = qualityMap[q] || q || 'Auto';
            qualityStatus.textContent = `Low-internet mode OFF. Quality: ${readable}`;
        } else {
            qualityStatus.textContent = 'Low-internet mode OFF.';
        }
    }
}

function clearQualityRetry() {
    if (qualityRetryTimer) {
        clearInterval(qualityRetryTimer);
        qualityRetryTimer = null;
    }
}

function startQualityMonitor() {
    clearQualityMonitor();
    qualityMonitorTimer = setInterval(() => {
        if (!player) return;
        const q = safeGetPlaybackQuality();
        const readable = qualityMap[q] || q || 'Auto';
        if (lowBandwidthMode) {
            const target = getLowestAvailableQuality() || 'small';
            // Display-only to avoid stutter
            qualityStatus.textContent = `Applied: ${readable} (target: ${qualityMap[target] || target})`;
        } else {
            qualityStatus.textContent = `Quality: ${readable}`;
        }
    }, 700);
}

function clearQualityMonitor() {
    if (qualityMonitorTimer) {
        clearInterval(qualityMonitorTimer);
        qualityMonitorTimer = null;
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
        // Make the simulate button available before playback so user can enable low mode early
        qualityButton.classList.remove('hidden');
        qualityStatus.textContent = ''; // Clear status on new video load
        // Reset toggle when new video is loaded (optional: keep state if desired)
        clearQualityRetry();
        clearQualityMonitor();
        lowBandwidthMode = false;
        qualityButton.textContent = 'Simulate Low Internet';
        clearQualityMonitor();
    } else {
        alert('Please enter a valid YouTube video link!');
    }
}
);

qualityButton.addEventListener('click', () => {
    // Toggle actual low-bandwidth behavior
    toggleLowInternetMode();
    if (lowBandwidthMode) {
        startQualityMonitor();
    } else {
        clearQualityMonitor();
    }
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

function removePauseOverlay() {
    const overlay = document.getElementById('pauseOverlay');
    if (overlay) overlay.remove();
}

function showPauseOverlay() {
    if (document.getElementById('pauseOverlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'pauseOverlay';
    overlay.className = 'pause-overlay';
    overlay.innerHTML = `
        <div class="pause-overlay-content">
            <div class="pause-title">Video paused</div>
            <button id="resumePlaybackBtn" class="resume-btn">Resume</button>
        </div>
    `;
    playerContainer.appendChild(overlay);
    const btn = overlay.querySelector('#resumePlaybackBtn');
    if (btn) {
        btn.addEventListener('click', () => {
            try { player && player.playVideo && player.playVideo(); } catch {}
            removePauseOverlay();
        });
    }
}

// --- YouTube PlayerVars ---
function createPlayerVars(videoId) {
    return {
        videoId,
        modestbranding: 1,
        controls: 1,
        showinfo: 0,
        rel: 0,
        autoplay: 1,
        disablekb: 1,
        enablejsapi: 1,
        widgetid: 1,
        origin: window.location.origin,
    };
}