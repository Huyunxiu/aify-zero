/**
 * Tells which row a policy change writes to.
 *
 * It is the session when the session has an id. The home route has no id, but the row
 * exists after the first message is stored. A change then must write to that new row, or
 * the UI and the database disagree, and the next Run uses the old policy.
 *
 * It returns undefined while the row does not exist: the first message carries the policy, and this code sends no request.
 */
export function approvalPolicyTarget(input: {
  sessionId: string | undefined;
  sessionKey: string;
  rowSaved: boolean;
}): string | undefined {
  return input.sessionId ?? (input.rowSaved ? input.sessionKey : undefined);
}
