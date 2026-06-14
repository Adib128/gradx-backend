-- CreateTable
CREATE TABLE "topic_clos" (
    "topicId" INTEGER NOT NULL,
    "cloId" INTEGER NOT NULL,

    CONSTRAINT "topic_clos_pkey" PRIMARY KEY ("topicId","cloId")
);

-- AddForeignKey
ALTER TABLE "topic_clos" ADD CONSTRAINT "topic_clos_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_clos" ADD CONSTRAINT "topic_clos_cloId_fkey" FOREIGN KEY ("cloId") REFERENCES "clos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
