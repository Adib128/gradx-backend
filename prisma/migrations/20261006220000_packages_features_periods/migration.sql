-- Packages: feature catalogue, per-package feature values, billing periods and per-period prices

ALTER TABLE "plans" ALTER COLUMN "priceMonthly" SET DEFAULT 0;

DO $$ BEGIN
  CREATE TYPE "PlanFeatureType" AS ENUM ('LIMIT', 'BOOLEAN');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "plan_features" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "type" "PlanFeatureType" NOT NULL DEFAULT 'LIMIT',
    "unitEn" TEXT,
    "unitAr" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "plan_features_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "plan_features_key_key" ON "plan_features"("key");
CREATE INDEX IF NOT EXISTS "plan_features_sortOrder_idx" ON "plan_features"("sortOrder");

CREATE TABLE IF NOT EXISTS "plan_feature_values" (
    "id" SERIAL NOT NULL,
    "planId" INTEGER NOT NULL,
    "featureId" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "limitValue" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "plan_feature_values_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "plan_feature_values_planId_featureId_key" ON "plan_feature_values"("planId", "featureId");
CREATE INDEX IF NOT EXISTS "plan_feature_values_featureId_idx" ON "plan_feature_values"("featureId");

CREATE TABLE IF NOT EXISTS "billing_periods" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "durationMonths" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_periods_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "billing_periods_code_key" ON "billing_periods"("code");
CREATE INDEX IF NOT EXISTS "billing_periods_sortOrder_idx" ON "billing_periods"("sortOrder");

CREATE TABLE IF NOT EXISTS "plan_prices" (
    "id" SERIAL NOT NULL,
    "planId" INTEGER NOT NULL,
    "periodId" INTEGER NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "compareAtPrice" DECIMAL(10,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "plan_prices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "plan_prices_planId_periodId_key" ON "plan_prices"("planId", "periodId");
CREATE INDEX IF NOT EXISTS "plan_prices_periodId_idx" ON "plan_prices"("periodId");

DO $$ BEGIN
  ALTER TABLE "plan_feature_values" ADD CONSTRAINT "plan_feature_values_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "plan_feature_values" ADD CONSTRAINT "plan_feature_values_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "plan_features"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "billing_periods"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Default catalogue (admins can edit or extend it)
INSERT INTO "plan_features" ("key", "nameEn", "nameAr", "type", "unitEn", "unitAr", "sortOrder") VALUES
  ('MAX_COURSES', 'Number of courses', 'عدد المقررات', 'LIMIT', 'courses', 'مقرر', 10),
  ('MAX_GENERATED_COURSES', 'Number of AI-generated courses', 'عدد المقررات المولدة بالذكاء الاصطناعي', 'LIMIT', 'courses', 'مقرر', 20),
  ('MAX_ASSESSMENTS', 'Number of assessments', 'عدد التقييمات', 'LIMIT', 'assessments', 'تقييم', 30),
  ('MAX_GENERATED_ASSESSMENTS', 'Number of AI-generated assessments', 'عدد التقييمات المولدة بالذكاء الاصطناعي', 'LIMIT', 'assessments', 'تقييم', 40),
  ('MAX_GRADING_SCANS', 'Number of graded answer sheets', 'عدد أوراق الإجابة المصححة', 'LIMIT', 'sheets', 'ورقة', 50),
  ('MAX_STUDENTS', 'Number of students', 'عدد الطلاب', 'LIMIT', 'students', 'طالب', 60),
  ('MAX_AI_REQUESTS', 'Number of AI requests', 'عدد طلبات الذكاء الاصطناعي', 'LIMIT', 'requests', 'طلب', 70),
  ('CUSTOM_BRANDING', 'Custom branding', 'هوية مخصصة', 'BOOLEAN', NULL, NULL, 80),
  ('LMS_INTEGRATION', 'LMS integration', 'التكامل مع أنظمة إدارة التعلم', 'BOOLEAN', NULL, NULL, 90),
  ('API_ACCESS', 'API access', 'الوصول إلى واجهة البرمجة', 'BOOLEAN', NULL, NULL, 100),
  ('PRIORITY_SUPPORT', 'Priority support', 'دعم ذو أولوية', 'BOOLEAN', NULL, NULL, 110)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "billing_periods" ("code", "nameEn", "nameAr", "durationMonths", "sortOrder") VALUES
  ('MONTHLY', 'Monthly', 'شهري', 1, 10),
  ('ANNUAL', 'Annual', 'سنوي', 12, 20)
ON CONFLICT ("code") DO NOTHING;

-- Carry existing packages over: monthly price and the three legacy limits
INSERT INTO "plan_prices" ("planId", "periodId", "price")
SELECT p."id", bp."id", p."priceMonthly"
FROM "plans" p CROSS JOIN "billing_periods" bp
WHERE bp."code" = 'MONTHLY'
ON CONFLICT ("planId", "periodId") DO NOTHING;

INSERT INTO "plan_feature_values" ("planId", "featureId", "enabled", "limitValue")
SELECT p."id", f."id", true,
  CASE f."key"
    WHEN 'MAX_COURSES' THEN p."maxCourses"
    WHEN 'MAX_ASSESSMENTS' THEN p."maxAssessments"
    WHEN 'MAX_AI_REQUESTS' THEN p."maxAiRequests"
  END
FROM "plans" p CROSS JOIN "plan_features" f
WHERE f."key" IN ('MAX_COURSES', 'MAX_ASSESSMENTS', 'MAX_AI_REQUESTS')
ON CONFLICT ("planId", "featureId") DO NOTHING;
