export type EmailLanguage = 'en' | 'ar';

export function buildVerificationEmail(
  code: string,
  language: EmailLanguage = 'en',
): { subject: string; text: string; html: string } {
  if (language === 'ar') {
    return {
      subject: 'رمز التحقق — GradX',
      text: `رمز التحقق الخاص بك هو: ${code}\nصالح لمدة 10 دقائق.`,
      html: `<p dir="rtl" style="font-family:sans-serif;font-size:16px;line-height:1.6">رمز التحقق الخاص بك هو: <strong style="letter-spacing:0.2em">${code}</strong><br/>صالح لمدة 10 دقائق.</p>`,
    };
  }

  return {
    subject: 'Your GradX verification code',
    text: `Your verification code is: ${code}\nIt expires in 10 minutes.`,
    html: `<p style="font-family:sans-serif;font-size:16px;line-height:1.6">Your verification code is: <strong style="letter-spacing:0.2em">${code}</strong><br/>It expires in 10 minutes.</p>`,
  };
}
