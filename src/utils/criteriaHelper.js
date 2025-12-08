/**
 * CriteriaHelper.js - MONGODB-STYLE CRITERIA MATCHING FOR GAME STATE
 * =============================================================================
 *
 * ROLE: Provides declarative criteria matching for game state conditions.
 * Uses MongoDB-style query operators for flexible state-based logic.
 *
 * KEY RESPONSIBILITIES:
 * - Match simple equality conditions
 * - Support comparison operators ($gt, $gte, $lt, $lte)
 * - Support set operators ($in, $nin, $eq, $ne)
 * - Check multiple criteria against state object
 *
 * OPERATORS:
 * - $eq: Equals (same as direct value)
 * - $ne: Not equals
 * - $gt/$gte: Greater than / greater than or equal
 * - $lt/$lte: Less than / less than or equal
 * - $in: Value in array
 * - $nin: Value not in array
 *
 * EXAMPLES:
 * - { currentState: GAME_STATES.PLAYING }
 * - { currentState: { $gte: GAME_STATES.XR_ACTIVE } }
 * - { currentState: { $in: [STATE1, STATE2] } }
 *
 * EXPORTS:
 * - matchesCriteria(value, criteria): Check single value
 * - checkCriteria(state, criteriaObj): Check all criteria against state
 *
 * USAGE: Used by UIStateConfig, dialogData, AudioSystem for conditional logic
 * =============================================================================
 */

/**
 * Check if a single value matches a criteria definition
 * @param {any} value - Value to check (e.g., state.currentState)
 * @param {any} criteria - Criteria definition (value, or object with operators)
 * @returns {boolean}
 */
export function matchesCriteria(value, criteria) {
  // Simple equality check
  if (
    typeof criteria !== "object" ||
    criteria === null ||
    Array.isArray(criteria)
  ) {
    return value === criteria;
  }

  // Operator-based checks
  for (const [operator, compareValue] of Object.entries(criteria)) {
    switch (operator) {
      case "$eq":
        if (value !== compareValue) return false;
        break;

      case "$ne":
        if (value === compareValue) return false;
        break;

      case "$gt":
        if (!(value > compareValue)) return false;
        break;

      case "$gte":
        if (!(value >= compareValue)) return false;
        break;

      case "$lt":
        if (!(value < compareValue)) return false;
        break;

      case "$lte":
        if (!(value <= compareValue)) return false;
        break;

      case "$in":
        if (!Array.isArray(compareValue) || !compareValue.includes(value))
          return false;
        break;

      case "$nin":
        if (!Array.isArray(compareValue) || compareValue.includes(value))
          return false;
        break;

      default:
        console.warn(`[CriteriaHelper] Unknown operator "${operator}"`);
        return false;
    }
  }

  return true;
}

/**
 * Check if game state matches all criteria
 * @param {Object} gameState - Current game state
 * @param {Object} criteria - Criteria object with key-value pairs
 * @returns {boolean}
 */
export function checkCriteria(gameState, criteria) {
  if (!criteria || typeof criteria !== "object") {
    return true; // No criteria means always match
  }

  for (const [key, value] of Object.entries(criteria)) {
    const stateValue = gameState[key];

    if (!matchesCriteria(stateValue, value)) {
      return false;
    }
  }

  return true;
}

export default {
  matchesCriteria,
  checkCriteria,
};
