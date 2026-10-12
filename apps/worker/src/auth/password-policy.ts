/**
 * NIST SP 800-63B style: length over composition rules, plus a deny-list of common and
 * context-specific passwords. (A breached-password API check is a P2 enhancement.)
 */
const COMMON = new Set([
  "password123",
  "password1234",
  "1234567890",
  "12345678910",
  "qwertyuiop",
  "qwerty12345",
  "iloveyou123",
  "admin12345",
  "welcome123",
  "letmein1234",
  "1q2w3e4r5t",
  "abcdefghij",
  "passw0rd123",
  "football123",
  "monkey12345",
  "india12345",
  "india@1234",
  "bharat1234",
  "password@123",
  "pass@12345",
  "abc@123456",
  "qwerty@123",
  "0987654321",
  "1111111111",
  "bikeauction",
  "bikeauction1",
  "bike@12345",
  "motorcycle1",
  "royalenfield",
  "vutto12345",
]);

export function passwordProblem(password: string, email: string, name: string): string | null {
  const p = password.toLowerCase();
  if (COMMON.has(p)) return "This password is too common. Choose something harder to guess.";
  if (/^(.)\1+$/.test(password)) return "Don't use a single repeated character.";
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (local.length >= 4 && p.includes(local))
    return "Don't include your email address in your password.";
  const first = name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (first.length >= 4 && p.includes(first)) return "Don't include your name in your password.";
  return null;
}
