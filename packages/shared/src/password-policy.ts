export interface PasswordPolicy {
  minLength: number;
  /** How many of the four character classes (lower, upper, digit, symbol) are required. */
  requiredClasses: number;
}

export const PASSWORD_MAX_LENGTH = 256;

export function checkPasswordPolicy(password: string, policy: PasswordPolicy, context: { username?: string } = {}): string[] {
  const errors: string[] = [];
  if (password.length < policy.minLength) errors.push(`Must be at least ${policy.minLength} characters.`);
  if (password.length > PASSWORD_MAX_LENGTH) errors.push(`Must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < policy.requiredClasses) {
    errors.push(`Must contain at least ${policy.requiredClasses} of: lowercase, uppercase, digit, symbol.`);
  }
  if (context.username && context.username.length >= 3 && password.toLowerCase().includes(context.username.toLowerCase())) {
    errors.push('Must not contain the username.');
  }
  return errors;
}
