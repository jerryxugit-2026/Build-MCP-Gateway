// src/ima.mjs — 腾讯 ima 知识库 OpenAPI 调用层
// 2026-10-25,按 xuewolai/ima-mcp-server v1.1.0 移植到 Worker(fetch)
// 凭证:env.IMA_CLIENT_ID / env.IMA_API_KEY(Cloudflare secret,不进代码)
// 能力 = ima OpenAPI 全集:搜索/浏览/读原文/读笔记正文/入 URL;删除/移动官方不存在

const WIKI = "https://ima.qq.com/openapi/wiki/v1";
const NOTE = "https://ima.qq.com/openapi/note/v1";

async function imaPost(env, apiPath, body, prefix = WIKI) {
  const res = await fetch(`${prefix}/${apiPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "ima-openapi-clientid": env.IMA_CLIENT_ID,
      "ima-openapi-apikey": env.IMA_API_KEY,
      "ima-openapi-ctx": "cf-worker-ima-mcp/1.0",
    },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`IMA API 返回非 JSON 响应(${res.status}):${text.slice(0, 200)}`);
  }
  if (parsed.code !== 0) {
    throw new Error(`IMA API 错误 [${parsed.code}]:${parsed.msg || "未知错误"}`);
  }
  return parsed.data ?? parsed;
}

export async function callImaTool(env, name, a) {
  a = a || {};
  switch (name) {
    case "search_knowledge_base":
      return imaPost(env, "search_knowledge_base", {
        query: a.query ?? "",
        cursor: a.cursor ?? "",
        limit: a.limit ?? 20,
      });

    case "get_knowledge_base":
      if (!Array.isArray(a.ids) || a.ids.length === 0) {
        throw new Error("ids 参数必须为非空数组");
      }
      return imaPost(env, "get_knowledge_base", { ids: a.ids });

    case "get_knowledge_list": {
      const body = {
        knowledge_base_id: a.knowledge_base_id,
        cursor: a.cursor ?? "",
        limit: a.limit ?? 20,
      };
      if (a.folder_id) body.folder_id = a.folder_id;
      return imaPost(env, "get_knowledge_list", body);
    }

    case "search_knowledge":
      return imaPost(env, "search_knowledge", {
        query: a.query,
        knowledge_base_id: a.knowledge_base_id,
        cursor: a.cursor ?? "",
      });

    case "get_media_info": {
      const info = await imaPost(env, "get_media_info", { media_id: a.media_id });
      const noteId = info?.notebook_ext_info?.notebook_id;
      if (noteId) {
        try {
          const doc = await imaPost(env, "get_doc_content", { note_id: String(noteId), target_content_format: 0 }, NOTE);
          info.note_content = doc?.content ?? "";
        } catch (e) {
          info.note_content_error = `笔记正文读取失败:${e.message || e}`;
        }
      }
      return info;
    }

    case "get_note_content":
      return imaPost(env, "get_doc_content", {
        note_id: String(a.note_id),
        target_content_format: a.target_content_format ?? 0,
      }, NOTE);

    case "get_addable_knowledge_base_list":
      return imaPost(env, "get_addable_knowledge_base_list", {
        cursor: a.cursor ?? "",
        limit: a.limit ?? 20,
      });

    case "import_urls": {
      const body = {
        knowledge_base_id: a.knowledge_base_id,
        urls: a.urls,
      };
      if (a.folder_id) body.folder_id = a.folder_id;
      return imaPost(env, "import_urls", body);
    }

    default:
      throw new Error(`未知工具:${name}`);
  }
}
