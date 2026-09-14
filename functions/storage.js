import { decryptConfig, encryptConfig, presignedUrl } from "./aws.js";
import { PREFIX, normalizePath } from "./_lib.js";

const DEFAULTS = { enabled: false, bucket: "", region: "us-east-1", prefix: "", capacityGb: 250, monthlyTransferGb: 500, accessKey: "", secretKey: "" };

// 用量统计：与 wrangler.jsonc 的 r2_buckets.bucket_name 保持一致
export const R2_BUCKET_NAME = "forum-uploads";
// Cloudflare R2 免费额度：每月 10 GB 标准存储（1 GB = 1,000,000,000 字节）
export const R2_FREE_TIER_BYTES = 10 * 1000 ** 3;
export const USAGE_CACHE_KEY = "usage_cache";
// 缓存有效期（秒）：避免每次打开后台都全量遍历储存桶
export const USAGE_TTL = 600;
const LIST_PAGE_SIZE = 1000;
const LIST_MAX_PAGES = 200;

export async function getAwsConfig(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'aws_config'").first();
  const saved = row ? await decryptConfig(row.value, env.SESSION_SECRET) : null;
  return { ...DEFAULTS, ...(saved || {}), prefix: normalizePath(saved?.prefix || "", true), enabled: Boolean(saved?.enabled && saved?.bucket && saved?.accessKey && saved?.secretKey) };
}

export function publicAwsConfig(config) {
  return { enabled: config.enabled, bucket: config.bucket, region: config.region, prefix: config.prefix, capacityGb: config.capacityGb, monthlyTransferGb: config.monthlyTransferGb, hasCredentials: Boolean(config.accessKey && config.secretKey) };
}

export async function saveAwsConfig(env, config) {
  const value = await encryptConfig(config, env.SESSION_SECRET);
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('aws_config', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").bind(value, Math.floor(Date.now() / 1000)).run();
}

export async function reserveAwsTransfer(env, config, bytes) {
  const month = new Date().toISOString().slice(0, 7);
  const gbLimit = Number(config.monthlyTransferGb);
  // 若未设置或为 0 / 负数，表示不限制 AWS 流量
  if (!gbLimit || gbLimit <= 0) {
    await env.DB.prepare("INSERT INTO storage_usage (month, bytes, downloads) VALUES (?1, ?2, 1) ON CONFLICT(month) DO UPDATE SET bytes=bytes+excluded.bytes, downloads=downloads+1").bind(month, Number(bytes || 0)).run();
    return true;
  }
  const limit = gbLimit * 1000 ** 3;
  const current = await env.DB.prepare("SELECT bytes FROM storage_usage WHERE month = ?1").bind(month).first();
  const used = Number(current?.bytes || 0);
  if (used + Number(bytes || 0) > limit) return false;
  await env.DB.prepare("INSERT INTO storage_usage (month, bytes, downloads) VALUES (?1, ?2, 1) ON CONFLICT(month) DO UPDATE SET bytes=bytes+excluded.bytes, downloads=downloads+1").bind(month, Number(bytes || 0)).run();
  return true;
}

export async function awsUsage(env) {
  const month = new Date().toISOString().slice(0, 7);
  return (await env.DB.prepare("SELECT bytes, downloads FROM storage_usage WHERE month = ?1").bind(month).first()) || { bytes: 0, downloads: 0 };
}

/**
 * 真实遍历 R2 储存桶，只累加本网盘自己的 pan-cloudflare/ 前缀对象。
 * 桶 forum-uploads 与论坛共用，因此必须带前缀，否则会混入论坛文件。
 */
export async function scanR2Usage(env) {
  if (!env.R2 || typeof env.R2.list !== "function") throw new Error("未绑定 R2 储存桶");
  let cursor;
  let bytes = 0;
  let objects = 0;
  let pages = 0;
  let limited = false;
  for (;;) {
    const page = await env.R2.list({ prefix: PREFIX, cursor, limit: LIST_PAGE_SIZE });
    const list = page?.objects || [];
    for (const object of list) bytes += Number(object.size || 0);
    objects += list.length;
    pages += 1;
    if (!page?.truncated || !page?.cursor) break;
    if (pages >= LIST_MAX_PAGES) {
      limited = true;
      break;
    }
    cursor = page.cursor;
  }
  return { bucket: R2_BUCKET_NAME, prefix: PREFIX, bytes, objects, pages, limited };
}

/** 通过 S3 ListObjectsV2 分页遍历 AWS 桶，累加对象大小。 */
export async function scanAwsUsage(config) {
  const prefix = normalizePath(config.prefix || "");
  let bytes = 0;
  let objects = 0;
  let pages = 0;
  let limited = false;
  let token;
  for (;;) {
    const query = { "list-type": "2", "max-keys": String(LIST_PAGE_SIZE) };
    if (prefix) query.prefix = prefix;
    if (token) query["continuation-token"] = token;
    const response = await fetch(await presignedUrl(config, "GET", "", { expires: 300, query }));
    if (!response.ok) throw new Error(`AWS 返回 ${response.status}`);
    const xml = await response.text();
    for (const match of xml.matchAll(/<Size>(\d+)<\/Size>/g)) bytes += Number(match[1]);
    objects += (xml.match(/<Contents>/g) || []).length;
    pages += 1;
    if (!/<IsTruncated>true<\/IsTruncated>/i.test(xml)) break;
    const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    if (!next) break;
    if (pages >= LIST_MAX_PAGES) {
      limited = true;
      break;
    }
    token = next[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  return { enabled: true, bucket: config.bucket, prefix: prefix || "(整桶)", bytes, objects, pages, limited };
}

/** 读取上次统计结果缓存（存于 D1 settings 表）。 */
export async function readUsageCache(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?1").bind(USAGE_CACHE_KEY).first();
    if (!row?.value) return null;
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export async function writeUsageCache(env, payload) {
  await env.DB
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .bind(USAGE_CACHE_KEY, JSON.stringify(payload), Math.floor(Date.now() / 1000))
    .run();
}
