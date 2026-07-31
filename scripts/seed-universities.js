/**
 * Seeds KSA universities (+ logo paths under /universities/*).
 * Usage: node scripts/seed-universities.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const COMMON_FACULTIES = [
  {
    id: 'csis',
    en: 'College of Computer Science and Information Systems',
    ar: 'كلية علوم الحاسب ونظم المعلومات',
  },
  { id: 'engineering', en: 'College of Engineering', ar: 'كلية الهندسة' },
  { id: 'science', en: 'College of Science', ar: 'كلية العلوم' },
  {
    id: 'business',
    en: 'College of Business Administration',
    ar: 'كلية إدارة الأعمال',
  },
  { id: 'medicine', en: 'College of Medicine', ar: 'كلية الطب' },
  { id: 'education', en: 'College of Education', ar: 'كلية التربية' },
  {
    id: 'arts',
    en: 'College of Arts and Humanities',
    ar: 'كلية الآداب والعلوم الإنسانية',
  },
  {
    id: 'sharia',
    en: 'College of Sharia and Law',
    ar: 'كلية الشريعة والقانون',
  },
];

const UNIVERSITIES = [
  { code: 'najran', nameEn: 'Najran University', nameAr: 'جامعة نجران', website: 'https://nu.edu.sa' },
  { code: 'ksu', nameEn: 'King Saud University', nameAr: 'جامعة الملك سعود', website: 'https://ksu.edu.sa' },
  { code: 'kau', nameEn: 'King Abdulaziz University', nameAr: 'جامعة الملك عبدالعزيز', website: 'https://kau.edu.sa' },
  {
    code: 'kfupm',
    nameEn: 'King Fahd University of Petroleum and Minerals',
    nameAr: 'جامعة الملك فهد للبترول والمعادن',
    website: 'https://kfupm.edu.sa',
    faculties: [
      {
        id: 'ccse',
        en: 'College of Computing and Mathematics',
        ar: 'كلية الحاسبات والرياضيات',
      },
      ...COMMON_FACULTIES.filter((f) => f.id !== 'csis'),
    ],
  },
  { code: 'uqu', nameEn: 'Umm Al-Qura University', nameAr: 'جامعة أم القرى', website: 'https://uqu.edu.sa' },
  {
    code: 'imamu',
    nameEn: 'Imam Mohammad Ibn Saud Islamic University',
    nameAr: 'جامعة الإمام محمد بن سعود الإسلامية',
    website: 'https://imamu.edu.sa',
  },
  { code: 'iu', nameEn: 'Islamic University of Madinah', nameAr: 'الجامعة الإسلامية بالمدينة المنورة', website: 'https://iu.edu.sa' },
  { code: 'kfu', nameEn: 'King Faisal University', nameAr: 'جامعة الملك فيصل', website: 'https://kfu.edu.sa' },
  { code: 'kku', nameEn: 'King Khalid University', nameAr: 'جامعة الملك خالد', website: 'https://kku.edu.sa' },
  { code: 'qu', nameEn: 'Qassim University', nameAr: 'جامعة القصيم', website: 'https://qu.edu.sa' },
  { code: 'taibah', nameEn: 'Taibah University', nameAr: 'جامعة طيبة', website: 'https://taibahu.edu.sa' },
  { code: 'taif', nameEn: 'Taif University', nameAr: 'جامعة الطائف', website: 'https://tu.edu.sa' },
  { code: 'hail', nameEn: "University of Ha'il", nameAr: 'جامعة حائل', website: 'https://uoh.edu.sa' },
  { code: 'jazan', nameEn: 'Jazan University', nameAr: 'جامعة جازان', website: 'https://jazanu.edu.sa' },
  { code: 'jouf', nameEn: 'Al Jouf University', nameAr: 'جامعة الجوف', website: 'https://ju.edu.sa' },
  { code: 'baha', nameEn: 'Al Baha University', nameAr: 'جامعة الباحة', website: 'https://bu.edu.sa' },
  { code: 'tabuk', nameEn: 'University of Tabuk', nameAr: 'جامعة تبوك', website: 'https://ut.edu.sa' },
  { code: 'nbu', nameEn: 'Northern Border University', nameAr: 'جامعة الحدود الشمالية', website: 'https://nbu.edu.sa' },
  {
    code: 'pnu',
    nameEn: 'Princess Nourah bint Abdulrahman University',
    nameAr: 'جامعة الأميرة نورة بنت عبدالرحمن',
    website: 'https://pnu.edu.sa',
  },
  {
    code: 'ksauhs',
    nameEn: 'King Saud bin Abdulaziz University for Health Sciences',
    nameAr: 'جامعة الملك سعود بن عبدالعزيز للعلوم الصحية',
    website: 'https://ksau-hs.edu.sa',
  },
  {
    code: 'iau',
    nameEn: 'Imam Abdulrahman Bin Faisal University',
    nameAr: 'جامعة الإمام عبدالرحمن بن فيصل',
    website: 'https://iau.edu.sa',
  },
  {
    code: 'psau',
    nameEn: 'Prince Sattam bin Abdulaziz University',
    nameAr: 'جامعة الأمير سطام بن عبدالعزيز',
    website: 'https://psau.edu.sa',
  },
  { code: 'shaqra', nameEn: 'Shaqra University', nameAr: 'جامعة شقراء', website: 'https://su.edu.sa' },
  { code: 'mu', nameEn: 'Majmaah University', nameAr: 'جامعة المجمعة', website: 'https://mu.edu.sa' },
  { code: 'seu', nameEn: 'Saudi Electronic University', nameAr: 'الجامعة السعودية الإلكترونية', website: 'https://seu.edu.sa' },
  { code: 'uj', nameEn: 'University of Jeddah', nameAr: 'جامعة جدة', website: 'https://uj.edu.sa' },
  { code: 'ub', nameEn: 'University of Bisha', nameAr: 'جامعة بيشة', website: 'https://ub.edu.sa' },
  { code: 'uhb', nameEn: 'University of Hafr Al Batin', nameAr: 'جامعة حفر الباطن', website: 'https://uhb.edu.sa' },
  {
    code: 'kaust',
    nameEn: 'King Abdullah University of Science and Technology',
    nameAr: 'جامعة الملك عبدالله للعلوم والتقنية',
    website: 'https://kaust.edu.sa',
    faculties: [
      {
        id: 'cemse',
        en: 'Computer, Electrical and Mathematical Sciences and Engineering',
        ar: 'علوم وهندسة الحاسب والكهرباء والرياضيات',
      },
    ],
  },
];

function resolveLogoUrl(code) {
  const dir = path.join(__dirname, '..', 'public', 'universities');
  const exts = ['svg', 'png', 'jpg', 'jpeg', 'webp'];
  for (const ext of exts) {
    if (fs.existsSync(path.join(dir, `${code}.${ext}`))) {
      return `/universities/${code}.${ext}`;
    }
  }
  return null;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  for (let i = 0; i < UNIVERSITIES.length; i++) {
    const uni = UNIVERSITIES[i];
    const logoUrl = resolveLogoUrl(uni.code);
    const faculties = JSON.stringify(uni.faculties || COMMON_FACULTIES);

    await pool.query(
      `
      INSERT INTO universities
        ("code", "nameEn", "nameAr", "website", "logoUrl", "faculties", "sortOrder", "updatedAt")
      VALUES
        ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW())
      ON CONFLICT ("code") DO UPDATE SET
        "nameEn" = EXCLUDED."nameEn",
        "nameAr" = EXCLUDED."nameAr",
        "website" = EXCLUDED."website",
        "logoUrl" = EXCLUDED."logoUrl",
        "faculties" = EXCLUDED."faculties",
        "sortOrder" = EXCLUDED."sortOrder",
        "updatedAt" = NOW()
      `,
      [
        uni.code,
        uni.nameEn,
        uni.nameAr,
        uni.website || null,
        logoUrl,
        faculties,
        i,
      ],
    );
    console.log(`${uni.code}: ${logoUrl || '(no logo)'}`);
  }

  const count = await pool.query('SELECT COUNT(*)::int AS c FROM universities');
  console.log(`Seeded ${count.rows[0].c} universities`);
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
