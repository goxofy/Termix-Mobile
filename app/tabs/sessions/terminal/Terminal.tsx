import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";
import {
  View,
  Text,
  ActivityIndicator,
  Dimensions,
  AccessibilityInfo,
  TouchableOpacity,
  type LayoutChangeEvent,
} from "react-native";
import { WebView } from "react-native-webview";
import * as Clipboard from "expo-clipboard";
import { ChevronDown, ClipboardPaste, Copy } from "lucide-react-native";
import { logActivity, getSnippets } from "../../../main-axios";
import { showToast } from "../../../utils/toast";
import { useTerminalCustomization } from "../../../contexts/TerminalCustomizationContext";
import {
  BACKGROUNDS,
  ACCENT,
  TEXT_COLORS,
} from "../../../constants/designTokens";
import {
  TOTPDialog,
  SSHAuthDialog,
  HostKeyVerificationDialog,
  PassphraseDialog,
  WarpgateDialog,
} from "@/app/tabs/dialogs";
import { TERMINAL_THEMES, TERMINAL_FONTS } from "@/constants/terminal-themes";
import { MOBILE_DEFAULT_TERMINAL_CONFIG } from "@/constants/terminal-config";
import type { TerminalConfig } from "@/types";
import {
  NativeWebSocketManager,
  type TerminalHostConfig,
  type HostKeyData,
} from "./NativeWebSocketManager";
import { loadXtermAssets } from "./loadXtermAssets";
import { ContextSheet } from "../_shared";
import { useConnectionLog, ConnectionLog } from "../_shared/useConnectionLog";

interface TerminalProps {
  hostConfig: {
    id: number;
    name: string;
    ip: string;
    port: number;
    username: string;
    authType: "password" | "key" | "credential" | "none";
    password?: string;
    key?: string;
    keyPassword?: string;
    keyType?: string;
    credentialId?: number;
    jumpHosts?: { hostId: number }[];
    forceKeyboardInteractive?: boolean;
    overrideCredentialUsername?: boolean;
    terminalConfig?: Partial<TerminalConfig>;
  };
  isVisible: boolean;
  title?: string;
  onClose?: () => void;
  onBackgroundColorChange?: (color: string) => void;
  /** Stable tab instance id (cross-device session tracking). */
  tabInstanceId?: string;
  /** Backend session id to attach to on first connect (reviving a tab). */
  initialSessionId?: string | null;
  /** Fired when the backend session id is created/attached/cleared. */
  onSessionIdChange?: (sessionId: string | null) => void;
  /** Requests focus for the native terminal IME after a plain terminal tap. */
  onRequestKeyboard?: () => void;
}

export type TerminalHandle = {
  sendInput: (data: string) => void;
  fit: () => void;
  isDialogOpen: () => boolean;
  notifyBackgrounded: () => void;
  notifyForegrounded: () => void;
  scrollToBottom: () => void;
  isSelecting: () => boolean;
};

const TerminalComponent = forwardRef<TerminalHandle, TerminalProps>(
  (
    {
      hostConfig,
      isVisible,
      title = "Terminal",
      onClose,
      onBackgroundColorChange,
      tabInstanceId,
      initialSessionId,
      onSessionIdChange,
      onRequestKeyboard,
    },
    ref,
  ) => {
    const webViewRef = useRef<WebView>(null);
    const wsManagerRef = useRef<NativeWebSocketManager | null>(null);
    const terminalColsRef = useRef(80);
    const terminalRowsRef = useRef(24);
    // Pixel height of the visible terminal area as measured by RN layout.
    // The WebView is shrunk by the TabBar/KeyboardBar/system-keyboard via the
    // parent's marginBottom, but inside the WebView `100vh`/`window.innerHeight`
    // is unreliable (WKWebView reports stale values after a frame resize). Pushing
    // the exact laid-out height lets xterm compute the correct row count, so TUI
    // apps (Claude Code, Codex, …) draw their bottom input row inside the visible
    // area instead of behind the chrome.
    const viewportHeightRef = useRef<number | null>(null);
    // Debounces onLayout pushes during LayoutAnimation / keyboard slide so the
    // pty isn't spammed with resize storms (each resize → SIGWINCH → TUI redraw).
    const viewportDebounceTimerRef = useRef<ReturnType<
      typeof setTimeout
    > | null>(null);
    const pendingDataRef = useRef<string[]>([]);
    const dataFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );
    const terminalContextReleaseTimerRef = useRef<ReturnType<
      typeof setTimeout
    > | null>(null);

    const { config } = useTerminalCustomization();
    const log = useConnectionLog();
    const [webViewKey, setWebViewKey] = useState(0);
    const [screenDimensions, setScreenDimensions] = useState(
      Dimensions.get("window"),
    );
    type ConnectionState =
      | "connecting"
      | "connected"
      | "reconnecting"
      | "disconnected"
      | "failed";
    const [connectionState, setConnectionState] =
      useState<ConnectionState>("connecting");
    const [retryCount, setRetryCount] = useState(0);
    const [hasReceivedData, setHasReceivedData] = useState(false);
    const [htmlContent, setHtmlContent] = useState("");
    const [terminalBackgroundColor, setTerminalBackgroundColor] =
      useState<string>(BACKGROUNDS.DARKEST);

    const [totpRequired, setTotpRequired] = useState(false);
    const [totpPrompt, setTotpPrompt] = useState("");
    const [isPasswordPrompt, setIsPasswordPrompt] = useState(false);
    const [showAuthDialog, setShowAuthDialog] = useState(false);
    const [authDialogReason, setAuthDialogReason] = useState<
      "no_keyboard" | "auth_failed" | "timeout"
    >("auth_failed");
    const [passphraseRequired, setPassphraseRequired] = useState(false);
    const [warpgateAuth, setWarpgateAuth] = useState<{
      url: string;
      securityKey: string;
    } | null>(null);
    const [isSelecting, setIsSelecting] = useState(false);
    const [terminalContextMenuVisible, setTerminalContextMenuVisible] =
      useState(false);
    const [
      terminalContextInteractionActive,
      setTerminalContextInteractionActive,
    ] = useState(false);
    const [terminalContextSelection, setTerminalContextSelection] =
      useState("");
    const [showScrollToBottomButton, setShowScrollToBottomButton] =
      useState(false);
    const [hostKeyVerification, setHostKeyVerification] = useState<{
      scenario: "new" | "changed";
      data: HostKeyData;
    } | null>(null);

    const xtermAssetsRef = useRef<{
      xtermJs: string;
      xtermCss: string;
      fitAddonJs: string;
    } | null>(null);

    const [isScreenReaderEnabled, setIsScreenReaderEnabled] = useState(false);
    const isScreenReaderEnabledRef = useRef(false);
    const [accessibilityText, setAccessibilityText] = useState("");
    const accessibilityBufferRef = useRef<string[]>([]);
    const accessibilityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );

    useEffect(() => {
      AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
        setIsScreenReaderEnabled(enabled);
        isScreenReaderEnabledRef.current = enabled;
      });
      const subscription = AccessibilityInfo.addEventListener(
        "screenReaderChanged",
        (enabled) => {
          setIsScreenReaderEnabled(enabled);
          isScreenReaderEnabledRef.current = enabled;
        },
      );
      return () => subscription.remove();
    }, []);

    const writeToAccessibility = useCallback((rawData: string) => {
      const cleaned = rawData
        .replace(/\x1b\[[0-9;]*[mGKHJABCDsu]/g, "")
        .replace(/\x1b\][^\x07]*\x07/g, "")
        .replace(/\x1b[()][AB012]/g, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
        .trim();

      if (!cleaned) return;

      const lines = cleaned.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length === 0) return;

      accessibilityBufferRef.current.push(...lines);
      if (accessibilityBufferRef.current.length > 5) {
        accessibilityBufferRef.current =
          accessibilityBufferRef.current.slice(-5);
      }

      if (accessibilityTimerRef.current) {
        clearTimeout(accessibilityTimerRef.current);
      }
      accessibilityTimerRef.current = setTimeout(() => {
        accessibilityTimerRef.current = null;
        const text = accessibilityBufferRef.current.join("\n");
        accessibilityBufferRef.current = [];
        setAccessibilityText(text);
        AccessibilityInfo.announceForAccessibility(text);
      }, 500);
    }, []);

    useEffect(() => {
      const subscription = Dimensions.addEventListener(
        "change",
        ({ window }) => {
          setScreenDimensions(window);
        },
      );

      return () => subscription?.remove();
    }, []);

    const handleConnectionFailure = useCallback(
      (errorMessage: string) => {
        showToast.error(errorMessage);
        setConnectionState("failed");
        if (onClose) {
          onClose();
        }
      },
      [onClose],
    );

    const generateHTML = useCallback(
      (assets: { xtermJs: string; xtermCss: string; fitAddonJs: string }) => {
        const { width, height } = screenDimensions;

        const terminalConfig: Partial<TerminalConfig> = {
          ...MOBILE_DEFAULT_TERMINAL_CONFIG,
          ...config,
          ...hostConfig.terminalConfig,
        };

        const baseFontSize = config.fontSize || 16;
        const charWidth = baseFontSize * 0.6;
        const lineHeight = baseFontSize * 1.2;
        const terminalWidth = Math.floor(width / charWidth);
        const terminalHeight = Math.floor(height / lineHeight);

        void terminalWidth;
        void terminalHeight;

        const themeName = terminalConfig.theme || "termix";
        const themeColors =
          TERMINAL_THEMES[themeName]?.colors || TERMINAL_THEMES.termix.colors;

        const bgColor = themeColors.background;
        setTerminalBackgroundColor(bgColor);
        if (onBackgroundColorChange) {
          onBackgroundColorChange(bgColor);
        }

        const fontConfig = TERMINAL_FONTS.find(
          (f) => f.value === terminalConfig.fontFamily,
        );
        const fontFamily = fontConfig?.fallback || TERMINAL_FONTS[0].fallback;

        return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terminal</title>
  <style>${assets.xtermCss}</style>
  <script>${assets.xtermJs}</script>
  <script>${assets.fitAddonJs}</script>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: ${themeColors.background};
      font-family: ${fontFamily};
      overflow: hidden;
      width: 100vw;
      height: 100vh;
    }

    #terminal {
      width: 100vw;
      height: 100vh;
      min-height: 100vh;
      padding: 4px 4px 20px 4px;
      margin: 0;
      box-sizing: border-box;
    }

    .xterm {
      width: 100% !important;
      height: 100% !important;
    }

    .xterm-viewport {
      width: 100% !important;
      height: 100% !important;
      overflow: hidden !important;
      -webkit-overflow-scrolling: auto;
    }

    /* Disable native touch-scrolling of the embedded terminal at the source.
       The terminal is scroll-driven exclusively by JS (synthetic WheelEvent →
       viewport.scrollTop). Without this, iOS WKWebView / Android WebView's
       native touch scroll of .xterm-viewport bubbles to the page when the
       (alternate) buffer is at its top, scrolling the whole WebView instead of
       the terminal. */
    html, body, #terminal, .xterm, .xterm-viewport, .xterm-screen {
      touch-action: none;
      -webkit-touch-action: none;
      -ms-touch-action: none;
    }

    .xterm {
      font-feature-settings: "liga" 1, "calt" 1;
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .xterm .xterm-screen {
      font-family: ${fontFamily} !important;
      font-variant-ligatures: contextual;
    }

    .xterm .xterm-screen .xterm-char {
      font-feature-settings: "liga" 1, "calt" 1;
    }

    .xterm .xterm-viewport::-webkit-scrollbar {
      width: 8px;
      background: transparent;
    }
    .xterm .xterm-viewport::-webkit-scrollbar-thumb {
      background: rgba(180,180,180,0.7);
      border-radius: 4px;
    }
    .xterm .xterm-viewport::-webkit-scrollbar-thumb:hover {
      background: rgba(120,120,120,0.9);
    }
    .xterm .xterm-viewport {
      scrollbar-width: thin;
      scrollbar-color: rgba(180,180,180,0.7) transparent;
    }
    * {
      -webkit-tap-highlight-color: transparent;
      -webkit-touch-callout: none;
    }

    html, body, #terminal, .xterm, .xterm-screen,
    .xterm-accessibility, .xterm-accessibility-tree {
      user-select: none;
      -webkit-user-select: none;
      -ms-user-select: none;
      -moz-user-select: none;
    }

    .terminal-native-selection-overlay,
    .terminal-native-selection-row,
    .terminal-native-selection-text {
      user-select: text !important;
      -webkit-user-select: text !important;
      -ms-user-select: text !important;
      -moz-user-select: text !important;
      -webkit-touch-callout: default !important;
    }

    .terminal-native-selection-overlay {
      position: absolute;
      inset: 0;
      z-index: 20;
      overflow: hidden;
      pointer-events: auto;
      cursor: text;
      margin: 0;
      padding: 0;
      color: transparent !important;
      background: transparent;
      -webkit-text-fill-color: transparent !important;
    }

    .terminal-native-selection-row {
      display: block;
      overflow: hidden;
      margin: 0;
      padding: 0;
      white-space: pre;
      color: transparent !important;
      background: transparent;
      -webkit-text-fill-color: transparent !important;
    }

    .terminal-native-selection-text {
      white-space: pre;
      color: transparent !important;
      -webkit-text-fill-color: transparent !important;
    }

    .terminal-native-selection-text::selection {
      color: transparent;
      background: ${themeColors.selectionBackground || "rgba(255, 255, 255, 0.3)"};
      -webkit-text-fill-color: transparent;
    }

    input, textarea, [contenteditable], .xterm-helper-textarea {
      position: absolute !important;
      left: -9999px !important;
      top: -9999px !important;
      width: 1px !important;
      height: 1px !important;
      opacity: 0 !important;
      pointer-events: none !important;
      color: transparent !important;
      background: transparent !important;
      border: none !important;
      outline: none !important;
      caret-color: transparent !important;
      -webkit-text-fill-color: transparent !important;
    }

  </style>
</head>
<body>
  <div id="terminal"></div>

  <script>
    const screenWidth = ${width};
    const screenHeight = ${height};

    const baseFontSize = ${baseFontSize};

    const terminal = new Terminal({
      cursorBlink: ${terminalConfig.cursorBlink || false},
      cursorStyle: '${terminalConfig.cursorStyle || "bar"}',
      scrollback: ${terminalConfig.scrollback || 10000},
      fontSize: baseFontSize,
      fontFamily: ${JSON.stringify(fontFamily)},
      letterSpacing: ${terminalConfig.letterSpacing || 0},
      lineHeight: ${terminalConfig.lineHeight || 1.2},
      theme: {
        background: '${themeColors.background}',
        foreground: '${themeColors.foreground}',
        cursor: '${themeColors.cursor || themeColors.foreground}',
        cursorAccent: '${themeColors.cursorAccent || themeColors.background}',
        selectionBackground: '${themeColors.selectionBackground || "rgba(255, 255, 255, 0.3)"}',
        selectionForeground: '${themeColors.selectionForeground || ""}',
        black: '${themeColors.black}',
        red: '${themeColors.red}',
        green: '${themeColors.green}',
        yellow: '${themeColors.yellow}',
        blue: '${themeColors.blue}',
        magenta: '${themeColors.magenta}',
        cyan: '${themeColors.cyan}',
        white: '${themeColors.white}',
        brightBlack: '${themeColors.brightBlack}',
        brightRed: '${themeColors.brightRed}',
        brightGreen: '${themeColors.brightGreen}',
        brightYellow: '${themeColors.brightYellow}',
        brightBlue: '${themeColors.brightBlue}',
        brightMagenta: '${themeColors.brightMagenta}',
        brightCyan: '${themeColors.brightCyan}',
        brightWhite: '${themeColors.brightWhite}'
      },
      allowTransparency: true,
      convertEol: true,
      screenReaderMode: true,
      windowsMode: false,
      macOptionIsMeta: false,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: false,
      fastScrollModifier: 'alt',
      fastScrollSensitivity: 5,
      allowProposedApi: true,
      disableStdin: false,
      cursorInactiveStyle: '${terminalConfig.cursorStyle || "bar"}'
    });

    const fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(document.getElementById('terminal'));

    // Bridge xterm-originated input (e.g. wheel events synthesized into SGR
    // mouse sequences / arrow keys) back to the pty. Regular keyboard input
    // goes through the RN IME and does not pass through this onData.
    terminal.onData(function(data) {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'input', data: data }));
      }
    });

    fitAddon.fit();
    terminal.write('\x1b[?25h');

    setTimeout(() => {
      const inputs = document.querySelectorAll('input, textarea, .xterm-helper-textarea');
      inputs.forEach(input => {
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('autocorrect', 'off');
        input.setAttribute('autocapitalize', 'off');
        input.setAttribute('spellcheck', 'false');
        input.style.color = 'transparent';
        input.style.caretColor = 'transparent';
        input.style.webkitTextFillColor = 'transparent';
      });
    }, 100);

    let isScrolledToBottom = true;
    let scrollStateFrame = null;

    function getIsScrolledToBottom() {
      try {
        return terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
      } catch(e) {
        return true;
      }
    }

    function postScrollState() {
      const nextIsAtBottom = getIsScrolledToBottom();
      if (nextIsAtBottom === isScrolledToBottom) {
        return;
      }

      isScrolledToBottom = nextIsAtBottom;
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'scrollState',
          data: { isAtBottom: isScrolledToBottom }
        }));
      }
    }

    function scheduleScrollStateUpdate() {
      if (scrollStateFrame !== null) {
        return;
      }

      scrollStateFrame = requestAnimationFrame(function() {
        scrollStateFrame = null;
        postScrollState();
      });
    }

    terminal.onScroll(scheduleScrollStateUpdate);

    // connectionEpoch is incremented each time notifyConnected fires.
    // The write callback captures its epoch at call time; if it no longer
    // matches the current epoch the connection already moved on, so we skip
    // the dataReceived notification to avoid spurious state changes.
    let connectionEpoch = 0;
    let notifiedEpoch = -1;
    window.writeToTerminal = function(data) {
      const shouldStickToBottom = getIsScrolledToBottom();
      const capturedEpoch = connectionEpoch;
      try {
        terminal.write(data, function() {
          if (notifiedEpoch !== capturedEpoch) {
            notifiedEpoch = capturedEpoch;
            if (window.ReactNativeWebView) {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'dataReceived' }));
            }
          }
          if (shouldStickToBottom) {
            terminal.scrollToBottom();
          }
          scheduleScrollStateUpdate();
        });
      } catch(e) {}
    };

    window.notifyConnected = function(fromBackground, isReattach) {
      connectionEpoch += 1;
      terminal.clear();
      if (isReattach) {
        terminal.write('\\x1b[2J\\x1b[H\\x1b[?25h');
      } else {
        terminal.reset();
        terminal.write('\\x1b[2J\\x1b[H\\x1b[?25h');
      }
    };

    const terminalElement = document.getElementById('terminal');
    const terminalScreen = terminal.element && terminal.element.querySelector('.xterm-screen');
    const nativeSelectionOverlay = document.createElement('div');
    nativeSelectionOverlay.className = 'terminal-native-selection-overlay';
    nativeSelectionOverlay.setAttribute('aria-hidden', 'true');
    nativeSelectionOverlay.setAttribute('role', 'presentation');
    if (terminalScreen) {
      terminalScreen.appendChild(nativeSelectionOverlay);
    }

    window.resetScroll = function() {
      terminal.scrollToBottom();
      scheduleScrollStateUpdate();
    }

    document.addEventListener('focusin', function(e) {
      if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (e.target && e.target.blur) {
          e.target.blur();
        }
        return false;
      }
    }, true);

    document.addEventListener('focus', function(e) {
      if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (e.target && e.target.blur) {
          e.target.blur();
        }
        return false;
      }
    }, true);

    let isCurrentlySelecting = false;
    let nativeSelectionSyncFrame = null;
    let nativeSelectionDirty = true;
    let nativeSelectionSnapshot = '';
    let mirrorInteractionActive = false;
    let touchInteractionActive = false;
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;
    let scrollTouchY = null;
    let pendingScrollLines = 0;
    let touchMoved = false;
    let touchScrollClaimed = false;
    let touchStartedWithSelection = false;
    let blankLongPressTimeout = null;
    let blankContextMenuOpened = false;
    const nativeSelectionHoldThreshold = 350;
    const blankContextMenuDelay = 600;

    function postTerminalContextMenu(selection) {
      if (!window.ReactNativeWebView) return;
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'terminalContextMenu',
        data: { selection: selection || '' }
      }));
    }

    function postTerminalKeyboardRequest() {
      if (!window.ReactNativeWebView) return;
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'terminalTap',
        data: {}
      }));
    }

    function postSelectionStart() {
      if (!window.ReactNativeWebView || isCurrentlySelecting) return;
      isCurrentlySelecting = true;
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'selectionStart',
        data: {}
      }));
    }

    function postSelectionEnd() {
      if (!window.ReactNativeWebView || !isCurrentlySelecting) return;
      isCurrentlySelecting = false;
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'selectionEnd',
        data: {}
      }));
    }

    function cancelBlankLongPress() {
      if (blankLongPressTimeout) {
        clearTimeout(blankLongPressTimeout);
        blankLongPressTimeout = null;
      }
    }

    function getNativeSelectionRange() {
      if (!nativeSelectionOverlay.parentNode) return null;

      try {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
          return null;
        }

        const range = selection.getRangeAt(0);
        if (range.intersectsNode(nativeSelectionOverlay)) {
          return range;
        }
      } catch(e) {}

      return null;
    }

    function hasTerminalSelection() {
      if (getNativeSelectionRange()) return true;

      try {
        return terminal.hasSelection();
      } catch(e) {
        return false;
      }
    }

    function updateTerminalSelectionState() {
      if (hasTerminalSelection()) {
        postSelectionStart();
      } else {
        postSelectionEnd();
      }
    }

    function syncNativeSelectionOverlay() {
      nativeSelectionSyncFrame = null;
      if (
        !nativeSelectionDirty ||
        !nativeSelectionOverlay.parentNode ||
        mirrorInteractionActive ||
        getNativeSelectionRange()
      ) {
        return;
      }

      try {
        const dimensions = terminal._core._renderService.dimensions.css;
        const cell = dimensions && dimensions.cell;
        const buffer = terminal.buffer.active;
        if (!cell || !cell.width || !cell.height || !buffer) return;

        const rows = [];
        for (let viewportRow = 0; viewportRow < terminal.rows; viewportRow += 1) {
          const bufferRow = buffer.viewportY + viewportRow;
          const line = buffer.getLine(bufferRow);
          rows.push({
            bufferRow: bufferRow,
            isWrapped: !!(line && line.isWrapped),
            text: line ? line.translateToString(true) : ''
          });
        }

        const canvas = dimensions.canvas || {};
        const overlayWidth = canvas.width || cell.width * terminal.cols;
        const overlayHeight = canvas.height || cell.height * terminal.rows;
        const snapshot = JSON.stringify({
          cols: terminal.cols,
          rows: terminal.rows,
          viewportY: buffer.viewportY,
          width: overlayWidth,
          height: overlayHeight,
          lines: rows
        });

        nativeSelectionDirty = false;
        if (snapshot === nativeSelectionSnapshot) return;
        nativeSelectionSnapshot = snapshot;

        nativeSelectionOverlay.style.width = overlayWidth + 'px';
        nativeSelectionOverlay.style.height = overlayHeight + 'px';
        nativeSelectionOverlay.style.fontFamily = terminal.options.fontFamily;
        nativeSelectionOverlay.style.fontSize = terminal.options.fontSize + 'px';
        nativeSelectionOverlay.style.fontWeight = terminal.options.fontWeight;
        nativeSelectionOverlay.style.letterSpacing = terminal.options.letterSpacing + 'px';
        nativeSelectionOverlay.style.lineHeight = cell.height + 'px';

        const fragment = document.createDocumentFragment();
        rows.forEach(function(rowData) {
          const row = document.createElement('div');
          row.className = 'terminal-native-selection-row';
          row.style.height = cell.height + 'px';
          row.style.lineHeight = cell.height + 'px';
          row.dataset.bufferRow = String(rowData.bufferRow);
          row.dataset.isWrapped = rowData.isWrapped ? 'true' : 'false';
          row.__terminalText = rowData.text;

          const text = document.createElement('span');
          text.className = 'terminal-native-selection-text';
          text.textContent = rowData.text;
          row.appendChild(text);
          fragment.appendChild(row);
        });

        nativeSelectionOverlay.textContent = '';
        nativeSelectionOverlay.appendChild(fragment);
      } catch(e) {}
    }

    function scheduleNativeSelectionOverlaySync() {
      nativeSelectionDirty = true;
      if (
        nativeSelectionSyncFrame !== null ||
        mirrorInteractionActive ||
        getNativeSelectionRange()
      ) {
        return;
      }

      nativeSelectionSyncFrame = requestAnimationFrame(syncNativeSelectionOverlay);
    }

    function isPointOverMirrorText(clientX, clientY) {
      try {
        const element = document.elementFromPoint(clientX, clientY);
        const text = element && element.closest
          ? element.closest('.terminal-native-selection-text')
          : null;
        if (!text || !nativeSelectionOverlay.contains(text)) return false;

        const rect = text.getBoundingClientRect();
        return (
          clientX >= rect.left - 2 &&
          clientX <= rect.right + 2 &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        );
      } catch(e) {
        return false;
      }
    }

    function getBoundaryOffset(row, text, container, offset) {
      const terminalText = row.__terminalText || '';
      if (!terminalText) return 0;

      if (container === row || container === text) {
        return offset <= 0 ? 0 : terminalText.length;
      }

      if (!text.contains(container)) {
        return 0;
      }

      try {
        const prefix = document.createRange();
        prefix.selectNodeContents(text);
        prefix.setEnd(container, offset);
        return Math.max(0, Math.min(terminalText.length, prefix.toString().length));
      } catch(e) {
        return 0;
      }
    }

    function joinTerminalSelectionRows(selectedRows) {
      let result = '';
      selectedRows.forEach(function(selectedRow, index) {
        result += selectedRow.text;
        if (index >= selectedRows.length - 1) return;

        if (!selectedRows[index + 1].isWrapped) {
          result += '\\n';
        }
      });
      return result;
    }

    function getNormalizedNativeSelectionText(range) {
      const selectedRows = [];
      const rows = nativeSelectionOverlay.querySelectorAll('.terminal-native-selection-row');

      rows.forEach(function(row) {
        let intersects = false;
        try {
          intersects = range.intersectsNode(row);
        } catch(e) {}
        if (!intersects) return;

        const text = row.querySelector('.terminal-native-selection-text');
        if (!text) return;

        const terminalText = row.__terminalText || '';
        const startInside = row === range.startContainer || row.contains(range.startContainer);
        const endInside = row === range.endContainer || row.contains(range.endContainer);
        const start = startInside
          ? getBoundaryOffset(row, text, range.startContainer, range.startOffset)
          : 0;
        const end = endInside
          ? getBoundaryOffset(row, text, range.endContainer, range.endOffset)
          : terminalText.length;

        selectedRows.push({
          isWrapped: row.dataset.isWrapped === 'true',
          text: terminalText.slice(Math.min(start, end), Math.max(start, end))
        });
      });

      if (selectedRows.length === 0) {
        const selection = window.getSelection();
        return selection ? selection.toString() : '';
      }

      return joinTerminalSelectionRows(selectedRows);
    }

    window.clearTerminalSelection = function() {
      try {
        const selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
        }
      } catch(e) {}
      try {
        terminal.clearSelection();
      } catch(e) {}

      touchInteractionActive = false;
      mirrorInteractionActive = false;
      nativeSelectionDirty = true;
      updateTerminalSelectionState();
      scheduleNativeSelectionOverlaySync();
    }

    document.addEventListener('selectionchange', function() {
      const nativeSelection = getNativeSelectionRange();
      if (nativeSelection) {
        cancelBlankLongPress();
      }
      updateTerminalSelectionState();
      if (!nativeSelection) {
        scheduleNativeSelectionOverlaySync();
      }
    });

    document.addEventListener('copy', function(e) {
      const range = getNativeSelectionRange();
      if (!range || !e.clipboardData) return;

      try {
        e.clipboardData.setData('text/plain', getNormalizedNativeSelectionText(range));
        e.preventDefault();
      } catch(error) {}
    }, true);

    nativeSelectionOverlay.addEventListener('contextmenu', function(e) {
      // Stop xterm's context-menu handler from selecting its hidden textarea,
      // but keep the WebView default so iOS/Android can show the system menu.
      e.stopPropagation();
    }, true);

    nativeSelectionOverlay.addEventListener('mousedown', function(e) {
      if (!touchInteractionActive) {
        mirrorInteractionActive = true;
      }
      e.stopPropagation();
    }, true);

    nativeSelectionOverlay.addEventListener('mouseup', function(e) {
      e.stopPropagation();
      if (!touchInteractionActive) {
        finishMirrorInteraction();
      }
    }, true);

    nativeSelectionOverlay.addEventListener('click', function(e) {
      e.stopPropagation();
    }, true);

    nativeSelectionOverlay.addEventListener('dblclick', function(e) {
      e.stopPropagation();
    }, true);

    // Keep touch scrolling routed through xterm so normal scrollback and
    // alternate-screen TUI mouse/key reporting continue to work.
    function dispatchTouchScroll(clientY) {
      if (scrollTouchY === null) {
        scrollTouchY = clientY;
        return;
      }

      const dy = scrollTouchY - clientY;
      scrollTouchY = clientY;
      const cell = terminal._core._renderService.dimensions.css.cell;
      const lineHeight = (cell && cell.height) || ${baseFontSize * 1.2};
      pendingScrollLines += dy / lineHeight;
      const wholeLines = Math.trunc(pendingScrollLines);
      if (wholeLines === 0) return;

      pendingScrollLines -= wholeLines;
      try {
        terminal.element.dispatchEvent(new WheelEvent('wheel', {
          deltaY: wholeLines,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          cancelable: true
        }));
      } catch(e) {}
    }

    function resetTouchGesture() {
      cancelBlankLongPress();
      touchMoved = false;
      touchScrollClaimed = false;
      touchStartedWithSelection = false;
      blankContextMenuOpened = false;
      scrollTouchY = null;
      pendingScrollLines = 0;
    }

    function finishMirrorInteraction() {
      if (!mirrorInteractionActive) return;
      mirrorInteractionActive = false;
      setTimeout(function() {
        updateTerminalSelectionState();
        scheduleNativeSelectionOverlaySync();
      }, 120);
    }

    nativeSelectionOverlay.addEventListener('touchstart', function(e) {
      e.stopPropagation();
      resetTouchGesture();
      touchInteractionActive = true;
      mirrorInteractionActive = true;

      if (!e.touches || e.touches.length !== 1) {
        touchMoved = true;
        e.preventDefault();
        return;
      }

      const touch = e.touches[0];
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      touchStartTime = Date.now();
      scrollTouchY = touch.clientY;
      touchStartedWithSelection = hasTerminalSelection();

      if (
        !touchStartedWithSelection &&
        !isPointOverMirrorText(touch.clientX, touch.clientY)
      ) {
        blankLongPressTimeout = setTimeout(function() {
          blankLongPressTimeout = null;
          if (
            touchMoved ||
            touchScrollClaimed ||
            getNativeSelectionRange()
          ) {
            return;
          }

          blankContextMenuOpened = true;
          postTerminalContextMenu('');
        }, blankContextMenuDelay);
      }
    }, { passive: false });

    nativeSelectionOverlay.addEventListener('touchmove', function(e) {
      e.stopPropagation();

      if (!e.touches || e.touches.length !== 1) {
        touchMoved = true;
        cancelBlankLongPress();
        e.preventDefault();
        return;
      }

      const touch = e.touches[0];
      const deltaX = Math.abs(touch.clientX - touchStartX);
      const deltaY = Math.abs(touch.clientY - touchStartY);
      const heldFor = Date.now() - touchStartTime;

      if (deltaX > 10 || deltaY > 10) {
        touchMoved = true;
        cancelBlankLongPress();

        if (
          !touchScrollClaimed &&
          !touchStartedWithSelection &&
          !getNativeSelectionRange() &&
          heldFor < nativeSelectionHoldThreshold
        ) {
          touchScrollClaimed = true;
        }
      }

      if (touchScrollClaimed) {
        e.preventDefault();
        dispatchTouchScroll(touch.clientY);
      }
    }, { passive: false });

    nativeSelectionOverlay.addEventListener('touchend', function(e) {
      e.stopPropagation();
      cancelBlankLongPress();

      if (e.touches && e.touches.length > 0) {
        touchMoved = true;
        return;
      }

      const heldFor = Date.now() - touchStartTime;
      const nativeSelection = getNativeSelectionRange();

      if (touchScrollClaimed) {
        e.preventDefault();
      } else if (
        !touchMoved &&
        !blankContextMenuOpened &&
        !touchStartedWithSelection &&
        !nativeSelection &&
        heldFor < nativeSelectionHoldThreshold
      ) {
        try {
          terminal.clearSelection();
        } catch(error) {}
        postSelectionEnd();
        postTerminalKeyboardRequest();
      }

      resetTouchGesture();
      touchInteractionActive = false;
      finishMirrorInteraction();
    }, { passive: false });

    nativeSelectionOverlay.addEventListener('touchcancel', function(e) {
      e.stopPropagation();
      cancelBlankLongPress();
      if (touchScrollClaimed) {
        e.preventDefault();
      }
      resetTouchGesture();
      touchInteractionActive = false;
      finishMirrorInteraction();
    }, { passive: false });

    nativeSelectionOverlay.addEventListener('wheel', function(e) {
      if (!getNativeSelectionRange()) return;
      e.preventDefault();
      e.stopPropagation();
    }, { passive: false });

    document.addEventListener('mouseup', function() {
      if (!mirrorInteractionActive || touchInteractionActive) return;
      finishMirrorInteraction();
    }, true);

    terminal.onSelectionChange(updateTerminalSelectionState);
    terminal.onRender(scheduleNativeSelectionOverlaySync);
    terminal.onScroll(scheduleNativeSelectionOverlaySync);
    terminal.onResize(scheduleNativeSelectionOverlaySync);
    if (
      terminal.buffer &&
      typeof terminal.buffer.onBufferChange === 'function'
    ) {
      terminal.buffer.onBufferChange(scheduleNativeSelectionOverlaySync);
    }
    scheduleNativeSelectionOverlaySync();

    function handleResize() {
      fitAddon.fit();
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'resize',
          data: { cols: terminal.cols, rows: terminal.rows }
        }));
      }
    }

    var lastViewportHeight = null;
    function applyViewportHeight(px, force) {
      var el = document.getElementById('terminal');
      if (!el || !px || px <= 0) return;
      if (!force && Math.abs(px - (lastViewportHeight || 0)) < 1) return;
      lastViewportHeight = px;

      el.style.height = px + 'px';
      el.style.minHeight = '0px';

      try {
        fitAddon.fit();
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'resize',
            data: { cols: terminal.cols, rows: terminal.rows }
          }));
        }
        // If the user was scrolled near the bottom, keep them pinned there so
        // the prompt/TUI input row stays visible after the resize.
        try {
          if (terminal.buffer.active.viewportY >= terminal.buffer.active.baseY - 1) {
            terminal.scrollToBottom();
          }
        } catch(e2) {}
      } catch(e) {}
    }
    window.setTerminalViewportHeight = function(px) {
      applyViewportHeight(px, false);
    }

    // Re-fit using the last RN-measured viewport height (if known) instead of
    // the possibly-stale 100vh, so RN-driven resizes (keyboard, orientation,
    // chrome show/hide) keep the row count in sync with the visible area.
    window.nativeFit = function() {
      if (lastViewportHeight) {
        applyViewportHeight(lastViewportHeight, true);
      } else {
        try { handleResize(); } catch(e) {}
      }
    }

    window.addEventListener('resize', function() {
      // Prefer the RN-measured height; fall back to the WebView's own viewport
      // when RN hasn't measured yet (e.g. initial load before onLayout).
      if (lastViewportHeight) {
        applyViewportHeight(lastViewportHeight, true);
      } else {
        try { handleResize(); } catch(e) {}
      }
    });

    window.addEventListener('orientationchange', function() {
      setTimeout(handleResize, 100);
    });

    terminal.clear();
    terminal.reset();
    terminal.write('\\x1b[2J\\x1b[H');

    setTimeout(function() {
      fitAddon.fit();
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'terminalReady',
          data: { cols: terminal.cols, rows: terminal.rows }
        }));
      }
    }, 150);
  </script>
</body>
</html>
    `;
      },
      [
        hostConfig,
        screenDimensions,
        config.fontSize,
        config.fontFamily,
        onBackgroundColorChange,
      ],
    );

    useEffect(() => {
      loadXtermAssets().then((assets) => {
        xtermAssetsRef.current = assets;
        setHtmlContent(generateHTML(assets));
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handlePostConnectionSetup = useCallback(async () => {
      const terminalConfig: Partial<TerminalConfig> = {
        ...MOBILE_DEFAULT_TERMINAL_CONFIG,
        ...config,
        ...hostConfig.terminalConfig,
      };

      setTimeout(async () => {
        if (terminalConfig.environmentVariables?.length) {
          terminalConfig.environmentVariables.forEach((envVar, index) => {
            setTimeout(
              () => {
                const key = envVar.key;
                const value = envVar.value;
                wsManagerRef.current?.sendInput(`export ${key}="${value}"\n`);
              },
              100 * (index + 1),
            );
          });
        }

        if (terminalConfig.startupSnippetId) {
          const snippetDelay =
            100 * (terminalConfig.environmentVariables?.length || 0) + 200;
          setTimeout(async () => {
            try {
              const snippets = await getSnippets();
              const snippet = snippets.find(
                (s: any) => s.id === terminalConfig.startupSnippetId,
              );
              if (snippet) {
                wsManagerRef.current?.sendInput(`${snippet.content}\n`);
              }
            } catch (err) {
              console.warn("Failed to execute startup snippet:", err);
            }
          }, snippetDelay);
        }

        if (terminalConfig.autoMosh && terminalConfig.moshCommand) {
          const moshDelay =
            100 * (terminalConfig.environmentVariables?.length || 0) +
            (terminalConfig.startupSnippetId ? 400 : 200);
          setTimeout(() => {
            wsManagerRef.current?.sendInput(`${terminalConfig.moshCommand!}\n`);
          }, moshDelay);
        }
      }, 500);
    }, [config, hostConfig.terminalConfig]);

    const handleTotpSubmit = useCallback(
      (code: string) => {
        wsManagerRef.current?.sendTotpResponse(code, isPasswordPrompt);
        setTotpRequired(false);
        setTotpPrompt("");
        setIsPasswordPrompt(false);
        setConnectionState("connecting");
      },
      [isPasswordPrompt],
    );

    const handleAuthDialogSubmit = useCallback(
      (credentials: {
        password?: string;
        sshKey?: string;
        keyPassword?: string;
      }) => {
        wsManagerRef.current?.sendReconnectWithCredentials(
          credentials,
          terminalColsRef.current,
          terminalRowsRef.current,
        );
        setShowAuthDialog(false);
        setConnectionState("connecting");
      },
      [],
    );

    const handleTerminalLayout = useCallback((event: LayoutChangeEvent) => {
      const h = Math.round(event.nativeEvent.layout.height || 0);
      if (h <= 0 || h === viewportHeightRef.current) {
        return;
      }
      viewportHeightRef.current = h;
      // Debounce so mid-animation frames don't each trigger a pty resize.
      if (viewportDebounceTimerRef.current) {
        clearTimeout(viewportDebounceTimerRef.current);
      }
      viewportDebounceTimerRef.current = setTimeout(() => {
        viewportDebounceTimerRef.current = null;
        try {
          webViewRef.current?.injectJavaScript(
            `window.setTerminalViewportHeight && window.setTerminalViewportHeight(${h}); true;`,
          );
        } catch (err) {}
      }, 80);
    }, []);

    const clearTerminalSelection = useCallback(() => {
      try {
        webViewRef.current?.injectJavaScript(
          `window.clearTerminalSelection && window.clearTerminalSelection(); true;`,
        );
      } catch {}
    }, []);

    const holdTerminalContextInteraction = useCallback(() => {
      if (terminalContextReleaseTimerRef.current) {
        clearTimeout(terminalContextReleaseTimerRef.current);
        terminalContextReleaseTimerRef.current = null;
      }
      setTerminalContextInteractionActive(true);
    }, []);

    const releaseTerminalContextInteraction = useCallback((delay = 0) => {
      if (terminalContextReleaseTimerRef.current) {
        clearTimeout(terminalContextReleaseTimerRef.current);
        terminalContextReleaseTimerRef.current = null;
      }

      if (delay > 0) {
        terminalContextReleaseTimerRef.current = setTimeout(() => {
          terminalContextReleaseTimerRef.current = null;
          setTerminalContextInteractionActive(false);
        }, delay);
      } else {
        setTerminalContextInteractionActive(false);
      }
    }, []);

    const closeTerminalContextMenu = useCallback(() => {
      setTerminalContextMenuVisible(false);
      setTerminalContextSelection("");
      // ContextSheet defers actions until the next frame. Keep this active
      // across that gap so Sessions does not restore the keyboard first.
      releaseTerminalContextInteraction(100);
    }, [releaseTerminalContextInteraction]);

    const handleContextMenuPaste = useCallback(async () => {
      holdTerminalContextInteraction();
      try {
        const clipboardContent = await Clipboard.getStringAsync();
        if (!clipboardContent) {
          showToast.info("Clipboard is empty");
          return;
        }

        clearTerminalSelection();
        wsManagerRef.current?.sendInput(clipboardContent);
      } catch {
        showToast.error("Unable to read the clipboard");
      } finally {
        releaseTerminalContextInteraction();
      }
    }, [
      clearTerminalSelection,
      holdTerminalContextInteraction,
      releaseTerminalContextInteraction,
    ]);

    const handleContextMenuCopy = useCallback(
      async (selection: string) => {
        if (!selection) return;

        holdTerminalContextInteraction();
        try {
          await Clipboard.setStringAsync(selection);
          clearTerminalSelection();
          showToast.success("Selection copied");
        } catch {
          showToast.error("Unable to copy the selection");
        } finally {
          releaseTerminalContextInteraction();
        }
      },
      [
        clearTerminalSelection,
        holdTerminalContextInteraction,
        releaseTerminalContextInteraction,
      ],
    );

    const handleWebViewMessage = useCallback(
      (event: any) => {
        try {
          const message = JSON.parse(event.nativeEvent.data);

          switch (message.type) {
            case "terminalReady":
              terminalColsRef.current = message.data.cols;
              terminalRowsRef.current = message.data.rows;
              // Re-apply the RN-measured viewport height now that the terminal
              // exists — onLayout may have fired before the HTML finished loading.
              if (viewportHeightRef.current) {
                webViewRef.current?.injectJavaScript(
                  `window.setTerminalViewportHeight && window.setTerminalViewportHeight(${viewportHeightRef.current}); true;`,
                );
              }
              wsManagerRef.current?.connect(
                message.data.cols,
                message.data.rows,
              );
              break;

            case "resize":
              terminalColsRef.current = message.data.cols;
              terminalRowsRef.current = message.data.rows;
              wsManagerRef.current?.sendResize(
                message.data.cols,
                message.data.rows,
              );
              break;

            case "selectionStart":
              setIsSelecting(true);
              break;

            case "selectionEnd":
              setIsSelecting(false);
              break;

            case "terminalContextMenu":
              holdTerminalContextInteraction();
              setTerminalContextSelection(
                typeof message.data?.selection === "string"
                  ? message.data.selection
                  : "",
              );
              setTerminalContextMenuVisible(true);
              break;

            case "terminalTap":
              onRequestKeyboard?.();
              break;

            case "scrollState":
              setShowScrollToBottomButton(!message.data.isAtBottom);
              break;

            case "input":
              // Wheel/mouse input synthesized inside the WebView (xterm onData),
              // forwarded to the pty so TUI apps can scroll their context.
              wsManagerRef.current?.sendInput(message.data);
              break;
          }
        } catch (error) {
          console.error("[Terminal] Error parsing WebView message:", error);
        }
      },
      [holdTerminalContextInteraction, onRequestKeyboard],
    );

    useEffect(() => {
      wsManagerRef.current?.destroy();

      wsManagerRef.current = new NativeWebSocketManager({
        hostConfig: hostConfig as TerminalHostConfig,
        tabInstanceId,
        initialSessionId,
        onSessionIdChange,
        onStateChange: (state, data) => {
          switch (state) {
            case "connecting": {
              const retryCount = (data?.retryCount as number) || 0;
              setConnectionState(
                retryCount > 0 ? "reconnecting" : "connecting",
              );
              setRetryCount(retryCount);
              log.append({
                level: "info",
                message:
                  retryCount > 0
                    ? `Reconnecting… (attempt ${retryCount})`
                    : `Connecting to ${hostConfig.name}…`,
              });
              break;
            }
            case "connected": {
              const fromBackground = data?.fromBackground as boolean;
              const isReattach = data?.isReattach as boolean;
              setConnectionState("connected");
              setRetryCount(0);
              if (!isReattach) {
                setHasReceivedData(false);
              }
              log.append({ level: "success", message: "Connected" });
              webViewRef.current?.injectJavaScript(
                `window.notifyConnected(${fromBackground}, ${isReattach}); true;`,
              );
              logActivity("terminal", hostConfig.id, hostConfig.name).catch(
                () => {},
              );
              break;
            }
            case "dataReceived":
              setHasReceivedData(true);
              break;
          }
        },
        onData: (data) => {
          pendingDataRef.current.push(data);
          if (!dataFlushTimerRef.current) {
            dataFlushTimerRef.current = setTimeout(() => {
              dataFlushTimerRef.current = null;
              const batch = pendingDataRef.current.join("");
              pendingDataRef.current = [];
              webViewRef.current?.injectJavaScript(
                `window.writeToTerminal(${JSON.stringify(batch)}); true;`,
              );
            }, 16);
          }
          if (isScreenReaderEnabledRef.current) {
            writeToAccessibility(data);
          }
        },
        onTotpRequired: (prompt, isPassword) => {
          setTotpPrompt(prompt);
          setIsPasswordPrompt(isPassword);
          setTotpRequired(true);
        },
        onAuthDialogNeeded: (reason) => {
          setAuthDialogReason(reason);
          setShowAuthDialog(true);
          setConnectionState("disconnected");
        },
        onHostKeyVerificationRequired: (scenario, data) => {
          setHostKeyVerification({ scenario, data });
        },
        onPassphraseRequired: () => {
          setPassphraseRequired(true);
        },
        onWarpgateAuthRequired: (url, securityKey) => {
          setWarpgateAuth({ url, securityKey });
        },
        onPostConnectionSetup: () => handlePostConnectionSetup(),
        onDisconnected: (hostName) => {
          setConnectionState("disconnected");
          showToast.warning(`Disconnected from ${hostName}`);
          if (onClose) onClose();
        },
        onConnectionFailed: (message) => {
          log.append({ level: "error", message });
          handleConnectionFailure(message);
        },
        onSessionEnded: () => {
          onClose?.();
        },
        onConnectionLog: (entry) => log.ingest([entry]),
      });

      log.clear();
      setWebViewKey((prev) => prev + 1);
      setConnectionState("connecting");
      setHasReceivedData(false);
      setRetryCount(0);
      setIsSelecting(false);
      setShowScrollToBottomButton(false);
      if (terminalContextReleaseTimerRef.current) {
        clearTimeout(terminalContextReleaseTimerRef.current);
        terminalContextReleaseTimerRef.current = null;
      }
      setTerminalContextMenuVisible(false);
      setTerminalContextInteractionActive(false);
      setTerminalContextSelection("");
      // Clear any stale auth/verification dialogs from a previous connection attempt.
      setHostKeyVerification(null);
      setTotpRequired(false);
      setShowAuthDialog(false);
      setPassphraseRequired(false);
      setWarpgateAuth(null);

      if (xtermAssetsRef.current) {
        setHtmlContent(generateHTML(xtermAssetsRef.current));
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hostConfig.id]);

    useEffect(() => {
      return () => {
        wsManagerRef.current?.destroy();
        wsManagerRef.current = null;
        if (dataFlushTimerRef.current) {
          clearTimeout(dataFlushTimerRef.current);
          dataFlushTimerRef.current = null;
        }
        if (accessibilityTimerRef.current) {
          clearTimeout(accessibilityTimerRef.current);
          accessibilityTimerRef.current = null;
        }
        if (viewportDebounceTimerRef.current) {
          clearTimeout(viewportDebounceTimerRef.current);
          viewportDebounceTimerRef.current = null;
        }
        if (terminalContextReleaseTimerRef.current) {
          clearTimeout(terminalContextReleaseTimerRef.current);
          terminalContextReleaseTimerRef.current = null;
        }
      };
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        sendInput: (data: string) => {
          wsManagerRef.current?.sendInput(data);
        },
        fit: () => {
          try {
            webViewRef.current?.injectJavaScript(
              `window.nativeFit && window.nativeFit(); true;`,
            );
          } catch (e) {}
        },
        isDialogOpen: () => {
          return (
            totpRequired ||
            showAuthDialog ||
            hostKeyVerification !== null ||
            passphraseRequired ||
            warpgateAuth !== null ||
            terminalContextMenuVisible ||
            terminalContextInteractionActive
          );
        },
        notifyBackgrounded: () => {
          wsManagerRef.current?.notifyBackgrounded();
        },
        notifyForegrounded: () => {
          wsManagerRef.current?.notifyForegrounded();
        },
        scrollToBottom: () => {
          try {
            setShowScrollToBottomButton(false);
            webViewRef.current?.injectJavaScript(
              `window.resetScroll && window.resetScroll(); true;`,
            );
          } catch (e) {}
        },
        isSelecting: () => {
          return (
            isSelecting ||
            terminalContextMenuVisible ||
            terminalContextInteractionActive
          );
        },
      }),
      [
        totpRequired,
        showAuthDialog,
        hostKeyVerification,
        passphraseRequired,
        warpgateAuth,
        terminalContextMenuVisible,
        terminalContextInteractionActive,
        isSelecting,
      ],
    );

    return (
      <View
        onLayout={handleTerminalLayout}
        style={{
          flex: isVisible ? 1 : 0,
          width: "100%",
          height: "100%",
          position: isVisible ? "relative" : "absolute",
          top: isVisible ? 0 : 0,
          left: isVisible ? 0 : 0,
          right: isVisible ? 0 : 0,
          bottom: isVisible ? 0 : 0,
          backgroundColor: terminalBackgroundColor,
        }}
      >
        <View
          style={{
            flex: 1,
            width: "100%",
            height: "100%",
            opacity: isVisible ? 1 : 0,
            position: "relative",
            zIndex: isVisible ? 1 : -1,
            backgroundColor: terminalBackgroundColor,
          }}
        >
          <View
            style={{ flex: 1, backgroundColor: terminalBackgroundColor }}
            pointerEvents={
              totpRequired || showAuthDialog || hostKeyVerification !== null
                ? "none"
                : "auto"
            }
          >
            <WebView
              key={`terminal-${hostConfig.id}-${webViewKey}`}
              ref={webViewRef}
              source={{ html: htmlContent }}
              style={{
                flex: 1,
                width: "100%",
                height: "100%",
                backgroundColor: terminalBackgroundColor,
                opacity:
                  connectionState === "connected" && hasReceivedData ? 1 : 0,
              }}
              javaScriptEnabled={true}
              domStorageEnabled={true}
              startInLoadingState={false}
              scalesPageToFit={false}
              allowsInlineMediaPlayback={true}
              mediaPlaybackRequiresUserAction={false}
              keyboardDisplayRequiresUserAction={false}
              hideKeyboardAccessoryView={true}
              textInteractionEnabled={true}
              cacheEnabled={false}
              cacheMode="LOAD_NO_CACHE"
              androidLayerType="hardware"
              onMessage={handleWebViewMessage}
              onError={(syntheticEvent) => {
                const { nativeEvent } = syntheticEvent;
                handleConnectionFailure(
                  `WebView error: ${nativeEvent.description}`,
                );
              }}
              onHttpError={(syntheticEvent) => {
                const { nativeEvent } = syntheticEvent;
                handleConnectionFailure(
                  `WebView HTTP error: ${nativeEvent.statusCode}`,
                );
              }}
              scrollEnabled={false}
              overScrollMode="never"
              bounces={false}
              showsHorizontalScrollIndicator={false}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled={false}
              textZoom={100}
              setSupportMultipleWindows={false}
            />
          </View>

          {showScrollToBottomButton &&
            isVisible &&
            connectionState === "connected" &&
            !totpRequired &&
            !showAuthDialog &&
            hostKeyVerification === null && (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Scroll to bottom"
                onPress={() => {
                  setShowScrollToBottomButton(false);
                  webViewRef.current?.injectJavaScript(
                    `window.resetScroll && window.resetScroll(); true;`,
                  );
                }}
                style={{
                  position: "absolute",
                  right: 14,
                  bottom: 16,
                  width: 40,
                  height: 40,
                  borderRadius: 0,
                  backgroundColor: BACKGROUNDS.CARD,
                  borderWidth: 1,
                  borderColor: ACCENT,
                  alignItems: "center",
                  justifyContent: "center",
                  zIndex: 20,
                  shadowColor: "#000",
                  shadowOpacity: 0.3,
                  shadowRadius: 6,
                  shadowOffset: { width: 0, height: 3 },
                  elevation: 6,
                }}
              >
                <ChevronDown size={20} color={ACCENT} />
              </TouchableOpacity>
            )}

          {/* Spinner shown until terminal has rendered its first output */}
          {(connectionState === "connecting" ||
            connectionState === "reconnecting" ||
            !hasReceivedData) &&
            connectionState !== "failed" && (
              <View
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  justifyContent: "center",
                  alignItems: "center",
                  backgroundColor: terminalBackgroundColor,
                  zIndex: 120,
                }}
              >
                <ActivityIndicator size="large" color={ACCENT} />
                <Text
                  style={{
                    color: TEXT_COLORS.PRIMARY,
                    fontSize: 16,
                    fontWeight: "600",
                    marginTop: 20,
                    textAlign: "center",
                    letterSpacing: 0.3,
                  }}
                >
                  {connectionState === "reconnecting"
                    ? "Reconnecting..."
                    : "Connecting..."}
                </Text>
                <Text
                  style={{
                    color: TEXT_COLORS.SECONDARY,
                    fontSize: 13,
                    marginTop: 6,
                    textAlign: "center",
                  }}
                >
                  {hostConfig.name}
                  {"  ·  "}
                  {hostConfig.ip}
                </Text>
              </View>
            )}

          <ConnectionLog
            entries={log.entries}
            isConnecting={
              connectionState === "connecting" ||
              connectionState === "reconnecting"
            }
            isConnected={connectionState === "connected"}
            hasConnectionError={connectionState === "failed"}
            onClear={log.clear}
          />
        </View>

        {isScreenReaderEnabled && (
          <View
            accessible={true}
            accessibilityLabel={accessibilityText}
            accessibilityLiveRegion="polite"
            style={{
              position: "absolute",
              width: 1,
              height: 1,
              opacity: 0,
              top: -1000,
              left: -1000,
            }}
          />
        )}

        <ContextSheet
          visible={terminalContextMenuVisible}
          onClose={closeTerminalContextMenu}
          title="Terminal actions"
          actions={[
            terminalContextSelection
              ? {
                  key: "copy",
                  icon: <Copy size={18} color={TEXT_COLORS.PRIMARY} />,
                  label: "Copy Selection",
                  onPress: () =>
                    handleContextMenuCopy(terminalContextSelection),
                }
              : null,
            {
              key: "paste",
              icon: <ClipboardPaste size={18} color={ACCENT} />,
              label: "Paste from Clipboard",
              onPress: handleContextMenuPaste,
            },
          ]}
        />

        <TOTPDialog
          visible={totpRequired}
          onSubmit={handleTotpSubmit}
          onCancel={() => {
            setTotpRequired(false);
            setTotpPrompt("");
            setIsPasswordPrompt(false);
            if (onClose) onClose();
          }}
          prompt={totpPrompt}
          isPasswordPrompt={isPasswordPrompt}
        />

        <SSHAuthDialog
          visible={showAuthDialog}
          onSubmit={handleAuthDialogSubmit}
          onCancel={() => {
            setShowAuthDialog(false);
            if (onClose) onClose();
          }}
          hostInfo={{
            name: hostConfig.name,
            ip: hostConfig.ip,
            port: hostConfig.port,
            username: hostConfig.username,
          }}
          reason={authDialogReason}
        />

        <HostKeyVerificationDialog
          visible={hostKeyVerification !== null}
          scenario={hostKeyVerification?.scenario ?? "new"}
          data={hostKeyVerification?.data ?? null}
          onAccept={() => {
            wsManagerRef.current?.sendHostKeyResponse("accept");
            setHostKeyVerification(null);
          }}
          onReject={() => {
            wsManagerRef.current?.sendHostKeyResponse("reject");
            setHostKeyVerification(null);
            if (onClose) onClose();
          }}
        />

        <PassphraseDialog
          visible={passphraseRequired}
          onSubmit={(passphrase) => {
            wsManagerRef.current?.sendPassphraseResponse(passphrase);
            setPassphraseRequired(false);
          }}
          onCancel={() => {
            setPassphraseRequired(false);
            if (onClose) onClose();
          }}
          hostInfo={{
            name: hostConfig.name,
            ip: hostConfig.ip,
            port: hostConfig.port,
            username: hostConfig.username,
          }}
        />

        <WarpgateDialog
          visible={warpgateAuth !== null}
          url={warpgateAuth?.url ?? ""}
          securityKey={warpgateAuth?.securityKey ?? ""}
          onContinue={() => {
            wsManagerRef.current?.sendWarpgateContinue();
            setWarpgateAuth(null);
          }}
          onCancel={() => {
            setWarpgateAuth(null);
            if (onClose) onClose();
          }}
        />
      </View>
    );
  },
);

TerminalComponent.displayName = "Terminal";

export { TerminalComponent as Terminal };
export default TerminalComponent;
