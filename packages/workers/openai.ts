import prisma, { BookmarkedLink } from "@remember/db";
import logger from "@remember/shared/logger";
import { ZOpenAIRequest, zOpenAIRequestSchema } from "@remember/shared/queues";
import { Job } from "bullmq";
import OpenAI from "openai";
import { z } from "zod";

const openAIResponseSchema = z.object({
  tags: z.array(z.string()),
});

function buildPrompt(url: string, description: string) {
  return `
You are a bot who given an article, extracts relevant "hashtags" out of them.
You must respond in JSON with the key "tags" and the value is list of tags.
----
URL: ${url}
Description: ${description}
  `;
}

async function fetchBookmark(linkId: string) {
  return await prisma.bookmark.findUnique({
    where: {
      id: linkId,
    },
    include: {
      link: true,
    },
  });
}

async function inferTags(jobId: string, link: BookmarkedLink, openai: OpenAI) {
  const linkDescription = link?.description;
  if (!linkDescription) {
    throw new Error(
      `[openai][${jobId}] No description found for link "${link.id}". Skipping ...`,
    );
  }

  const chatCompletion = await openai.chat.completions.create({
    messages: [
      { role: "system", content: buildPrompt(link.url, linkDescription) },
    ],
    model: "gpt-3.5-turbo-0125",
    response_format: { type: "json_object" },
  });

  const response = chatCompletion.choices[0].message.content;
  if (!response) {
    throw new Error(`[openai][${jobId}] Got no message content from OpenAI`);
  }

  try {
    let tags = openAIResponseSchema.parse(JSON.parse(response)).tags;
    logger.info(
      `[openai][${jobId}] Inferring tag for url "${link.url}" used ${chatCompletion.usage?.total_tokens} tokens and inferred: ${tags}`,
    );

    // Sometimes the tags contain the hashtag symbol, let's strip them out if they do.
    tags = tags.map((t) => {
      if (t.startsWith("#")) {
        return t.slice(1);
      }
      return t;
    });

    return tags;
  } catch (e) {
    throw new Error(
      `[openai][${jobId}] Failed to parse JSON response from OpenAI: ${e}`,
    );
  }
}

async function createTags(tags: string[], userId: string) {
  const existingTags = await prisma.bookmarkTags.findMany({
    select: {
      id: true,
      name: true,
    },
    where: {
      userId,
      name: {
        in: tags,
      },
    },
  });

  const existingTagSet = new Set<string>(existingTags.map((t) => t.name));

  const newTags = tags.filter((t) => !existingTagSet.has(t));

  // TODO: Prisma doesn't support createMany in Sqlite
  const newTagObjects = await Promise.all(
    newTags.map((t) => {
      return prisma.bookmarkTags.create({
        data: {
          name: t,
          userId: userId,
        },
      });
    }),
  );

  return existingTags.map((t) => t.id).concat(newTagObjects.map((t) => t.id));
}

async function connectTags(bookmarkId: string, tagIds: string[]) {
  // TODO: Prisma doesn't support createMany in Sqlite
  await Promise.all(
    tagIds.map((tagId) => {
      return prisma.tagsOnBookmarks.create({
        data: {
          tagId,
          bookmarkId,
          attachedBy: "ai",
        },
      });
    }),
  );
}

export default async function runOpenAI(job: Job<ZOpenAIRequest, void>) {
  const jobId = job.id || "unknown";

  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_ENABLED) {
    return;
  }

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  if (!openai) {
    logger.debug(
      `[openai][${jobId}] OpenAI is not configured, nothing to do now`,
    );
    return;
  }

  const request = zOpenAIRequestSchema.safeParse(job.data);
  if (!request.success) {
    throw new Error(
      `[openai][${jobId}] Got malformed job request: ${request.error.toString()}`,
    );
  }

  const { bookmarkId } = request.data;
  const bookmark = await fetchBookmark(bookmarkId);
  if (!bookmark) {
    throw new Error(
      `[openai][${jobId}] bookmark with id ${bookmarkId} was not found`,
    );
  }

  if (!bookmark.link) {
    throw new Error(
      `[openai][${jobId}] bookmark with id ${bookmarkId} doesn't have a link`,
    );
  }

  const tags = await inferTags(jobId, bookmark.link, openai);

  const tagIds = await createTags(tags, bookmark.userId);
  await connectTags(bookmarkId, tagIds);
}