/**
 * Logger.js - CLASS-SPECIFIC DEBUG LOGGING UTILITY
 * =============================================================================
 *
 * ROLE: Provides prefixed console logging with per-instance debug toggles.
 * Allows enabling/disabling verbose logging per module without global changes.
 *
 * KEY RESPONSIBILITIES:
 * - Prefix all log messages with class/module name
 * - Conditionally log based on debug flag
 * - Always log warnings and errors (regardless of debug flag)
 * - Support runtime debug toggle via setDebug()
 *
 * LOG LEVELS:
 * - log(...args): Debug messages (only if debug=true)
 * - warn(...args): Warnings (always shown)
 * - error(...args): Errors (always shown)
 * - logRaw(...args): Debug without prefix (only if debug=true)
 *
 * USAGE:
 *   this.logger = new Logger('ModuleName', false);
 *   this.logger.log('Debug info');  // Only if debug=true
 *   this.logger.warn('Warning');    // Always shown
 *
 * EXPORTS: Logger class, default export
 * =============================================================================
 */

export class Logger {
  constructor(name = "App", debug = false) {
    this.name = name;
    this.debug = debug;
  }

  /**
   * Log message (only if debug is enabled)
   * @param {...any} args - Arguments to log
   */
  log(...args) {
    if (this.debug) {
      console.log(`[${this.name}]`, ...args);
    }
  }

  /**
   * Always log warnings (regardless of debug flag)
   * @param {...any} args - Arguments to log
   */
  warn(...args) {
    console.warn(`[${this.name}]`, ...args);
  }

  /**
   * Always log errors (regardless of debug flag)
   * @param {...any} args - Arguments to log
   */
  error(...args) {
    console.error(`[${this.name}]`, ...args);
  }

  /**
   * Log message without prefix (only if debug is enabled)
   * Useful for structured data that should be copy-paste friendly
   * @param {...any} args - Arguments to log
   */
  logRaw(...args) {
    if (this.debug) {
      console.log(...args);
    }
  }

  /**
   * Enable or disable debug logging
   * @param {boolean} enabled - Whether to enable debug logging
   */
  setDebug(enabled) {
    this.debug = enabled;
  }
}

export default Logger;
