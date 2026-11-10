// Map page languages (BCP 47) onto the server's language codes.

export const SERVER_LANGS = ['en_us', 'en_gb', 'cmn', 'es', 'ja', 'fr_fr', 'de', 'it', 'pt_br', 'ko', 'hi', 'ar', 'bn', 'id',
  'ur', 'ru', 'pcm', 'mr', 'vi', 'te', 'sw', 'ha'];

export const LANG_LABELS = {
  en_us: 'English (US)', en_gb: 'English (UK)', cmn: 'Chinese (Mandarin)', es: 'Spanish', ja: 'Japanese',
  fr_fr: 'French', de: 'German', it: 'Italian', pt_br: 'Portuguese (BR)', ko: 'Korean',
  hi: 'Hindi', ar: 'Arabic', bn: 'Bengali', id: 'Indonesian', ur: 'Urdu', ru: 'Russian', pcm: 'Nigerian Pidgin',
  mr: 'Marathi', vi: 'Vietnamese', te: 'Telugu', sw: 'Swahili', ha: 'Hausa',
};

// Locale handed to Intl.Segmenter for each server code.
export const LOCALES = {
  en_us: 'en-US', en_gb: 'en-GB', cmn: 'zh', es: 'es', ja: 'ja', fr_fr: 'fr', de: 'de', it: 'it', pt_br: 'pt-BR', ko: 'ko',
  hi: 'hi', ar: 'ar', bn: 'bn', id: 'id', ur: 'ur', ru: 'ru', pcm: 'en', mr: 'mr', vi: 'vi', te: 'te', sw: 'sw', ha: 'ha',
};

// Seconds of audio per character, used until real measurements for a voice/language come in.
export const SEED_RATES = {
  en_us: 0.062, en_gb: 0.062, es: 0.058, fr_fr: 0.060, de: 0.064, it: 0.058, pt_br: 0.060,
  ja: 0.14, cmn: 0.22, ko: 0.13,
  hi: 0.075, ar: 0.075, bn: 0.075, id: 0.058, ur: 0.075, ru: 0.060, pcm: 0.062, mr: 0.075, vi: 0.058, te: 0.080,
  sw: 0.058, ha: 0.058,
};

const GB_REGIONS = new Set(['gb', 'uk', 'ie', 'au', 'nz', 'za']);
const DIRECT = new Set(['hi', 'ar', 'bn', 'id', 'ur', 'ru', 'pcm', 'mr', 'vi', 'te', 'sw', 'ha']);

export function mapLang(tag) {
  if (!tag) return null;
  const [base, region] = String(tag).trim().toLowerCase().replace('_', '-').split('-');
  switch (base) {
    case 'en': return GB_REGIONS.has(region) ? 'en_gb' : 'en_us';
    case 'zh': case 'cmn': return 'cmn';
    case 'es': return 'es';
    case 'ja': return 'ja';
    case 'fr': return 'fr_fr';
    case 'de': return 'de';
    case 'it': return 'it';
    case 'pt': return 'pt_br';
    case 'ko': return 'ko';
    case 'in': return 'id';    // legacy ISO 639 code for Indonesian
    default: return DIRECT.has(base) ? base : null;
  }
}

// Last-resort guess from the writing system when neither <html lang> nor CLD3 gives a supported language.
export function guessFromScript(text) {
  const sample = String(text || '').slice(0, 2000);
  const count = re => (sample.match(re) || []).length;
  const kana = count(/[぀-ヿ]/g), hangul = count(/[가-힯]/g), han = count(/[一-鿿]/g);
  if (kana > 10) return 'ja';
  if (hangul > 10) return 'ko';
  if (han > 10) return 'cmn';
  if (count(/[\u0400-\u04FF]/g) > 10) return 'ru';
  if (count(/[\u0600-\u06FF]/g) > 10) return 'ar';
  if (count(/[\u0900-\u097F]/g) > 10) return 'hi';
  if (count(/[\u0980-\u09FF]/g) > 10) return 'bn';
  if (count(/[\u0C00-\u0C7F]/g) > 10) return 'te';
  return null;
}

// tag: <html lang>; cld: result of chrome.i18n.detectLanguage ({isReliable, languages:[{language, percentage}]}).
// CLD3 wins over <html lang> when it is confident and disagrees (a wrong lang attribute is common).
export function pickLang({override, tag, cld, text, fallback = 'en_us'}) {
  if (override && override !== 'auto' && SERVER_LANGS.includes(override)) return {lang: override, source: 'override'};
  const fromTag = mapLang(tag);
  const top = cld?.languages?.[0];
  const fromCld = top ? mapLang(top.language) : null;
  const cldSure = !!(fromCld && cld.isReliable && top.percentage >= 80);
  if (fromTag && cldSure && fromCld.slice(0, 2) !== fromTag.slice(0, 2)) return {lang: fromCld, source: 'detected'};
  if (fromTag) return {lang: fromTag, source: 'page'};
  if (fromCld) return {lang: fromCld, source: 'detected'};
  const fromScript = guessFromScript(text);
  if (fromScript) return {lang: fromScript, source: 'script'};
  return {lang: fallback, source: 'fallback', unsupported: !!(tag || top)};
}
