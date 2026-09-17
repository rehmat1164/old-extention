// ai-client.js (gemini-client.js) — NVIDIA API integration for AI-powered prompt repair
// Uses NVIDIA's OpenAI-compatible REST endpoint with selectable Qwen/DeepSeek models.

const NVIDIA_API_BASE = 'https://integrate.api.nvidia.com/v1';
const AI_RETRY_MODELS = {
    qwen: {
        id: 'qwen',
        label: 'NVIDIA Qwen',
        model: 'qwen/qwen3-coder-480b-a35b-instruct'
    },
    deepseek: {
        id: 'deepseek',
        label: 'NVIDIA DeepSeek',
        model: 'deepseek-ai/deepseek-v4-pro',
        requestExtras: {
            chat_template_kwargs: { thinking: false }
        }
    }
};
const DEFAULT_AI_RETRY_MODEL = 'deepseek';
const RETRY_FLOW_RULES = {
    1: {
        task: 'strict_safe_retry_prompt',
        failedReason: 'Likely safety trigger: prompt may include minors, young-looking people, school-related settings, guardians, distress, difficult events, cover-up implications, or unsafe emotional context.',
        instruction: 'Rewrite this failed AI image/video prompt for maximum safety compliance. Preserve only safe cinematic elements such as camera angle, lighting, environment type, motion style, and technical quality. You may change unsafe subjects, actions, mood, or setting if needed. Remove all references to minors, children, young people, school, guardians, distress, tragedy, violence, abuse, harassment, hate, protected groups, cover-ups, hidden documents, fear, panic, sexualization, revealing outfits, leotards, tutus, weapons, blood, injury, crime, or harm. Replace risky elements with adult-only neutral subjects, modest clothing, everyday public spaces, calm routine actions, and a non-threatening mood. Keep the structure: [CAMERA], [PLACE], [SUBJECT], [ACTION], [PHYSICS], [MOOD], [TECH]. Output only the rewritten prompt. Do not explain changes. Do not include markdown.'
    },
    2: {
        task: 'make_prompt_even_safer',
        failedReason: 'The first rewritten prompt still failed strict safety filtering. Make the prompt safer by removing people if needed and converting the scene into neutral objects, buildings, papers, light, and camera motion only.',
        instruction: 'Make this prompt even safer for strict image/video generation filters. Do not preserve risky details. Remove all people if needed. Convert the scene into neutral objects, buildings, hands, papers, light, and camera motion only. Remove minors, young people, school, guardians, distress, tragedy, fear, panic, violence, abuse, harassment, hate, protected-community references, cover-ups, hidden evidence, emotional darkness, or any unsafe implication. Keep only safe camera movement, lighting, environment, and cinematic technical style. Return only the rewritten prompt. No explanation. Do not include markdown.'
    },
    3: {
        task: 'object_only_fallback',
        failedReason: 'Previous rewritten prompts still failed strict safety filtering. Using object-only fallback with no people, no minors, no school, no distress, no violence, no protected groups, and no emotional tragedy.',
        instruction: 'Use this safe object-only fallback prompt directly. Do not send it to AI for rewriting unless needed.'
    }
};

/**
 * System prompt for policy-safe prompt repair.
 * Instructs the model to fix content policy violations while preserving intent.
 */
const SYSTEM_PROMPT = `You are an expert AI prompt editor specializing in content policy compliance for AI video and image generators.

A user's prompt was rejected by an AI generator for policy violations. Your task: fix this prompt and give a better version that an AI video generator should not deny or refuse, while keeping the EXACT SAME creative intent, subject matter, theme, visual style, and mood.

STRICT RULES:
1. Keep the same subject — if it is about a dragon flying over a city, it must still be about a dragon flying over a city
2. Keep the same visual mood, style, and action
3. ONLY remove or rephrase specific words/phrases causing violations
4. Do NOT add unrelated subjects, do NOT completely rewrite the prompt
5. Make the result safer, clearer, natural, and descriptive for AI video generation
6. You must make a real edit; never return the exact same prompt
7. Return ONLY the edited prompt text - no explanations, no quotes, no extra words`;

const SYSTEM_PROMPT_V2 = `You are an expert AI prompt editor specializing in content policy compliance for AI video and image generators.

A user's prompt was rejected by an AI generator for policy or strict safety reasons. Follow the retry_flow instruction exactly for the current retry_count. Safety is more important than preserving risky subjects or story details.

STRICT RULES:
1. Preserve safe cinematic elements when possible: camera movement, lighting, environment type, motion style, tag structure, and technical quality.
2. Remove or replace unsafe subjects, actions, mood, setting, or implications when the retry_flow instruction says to do so.
3. Do not include minors, children, young-looking people, school-related details, guardians, distress, tragedy, fear, panic, violence, abuse, harassment, hate, protected-community targeting, cover-ups, hidden evidence, sexualization, revealing outfits, weapons, blood, injury, crime, or harm.
4. Make a real edit; never return the exact same prompt.
5. Return only the requested output format. No explanations, no markdown, no quotes around rewritten prompts.`;

/**
 * Build the NVIDIA API chat completions URL.
 */
function buildUrl() {
    return `${NVIDIA_API_BASE}/chat/completions`;
}

function getAiRetryModelConfig(modelId = DEFAULT_AI_RETRY_MODEL) {
    return AI_RETRY_MODELS[modelId] || AI_RETRY_MODELS[DEFAULT_AI_RETRY_MODEL];
}

async function getStoredAiRetryModelConfig() {
    try {
        const data = await chrome.storage.local.get({ aiRetryModel: DEFAULT_AI_RETRY_MODEL });
        return getAiRetryModelConfig(data.aiRetryModel);
    } catch (_) {
        return getAiRetryModelConfig();
    }
}

function buildChatRequestBody(config, body) {
    return {
        ...body,
        model: config.model,
        ...(config.requestExtras || {})
    };
}

export function getAiRetryModelLabel(modelId = DEFAULT_AI_RETRY_MODEL) {
    return getAiRetryModelConfig(modelId).label;
}

function normalizeForChangeCheck(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/[^a-z0-9]+/g, '');
}

function hasMeaningfulEdit(originalText, editedText) {
    const original = normalizeForChangeCheck(originalText);
    const edited = normalizeForChangeCheck(editedText);
    return !!edited && edited !== original;
}

function numberedPromptText(prompts) {
    const list = Array.isArray(prompts) ? prompts : [prompts];
    return list.map(item => {
        const promptNumber = Number(item?.promptNumber) || Number(item?.index) + 1 || 1;
        const text = String(item?.prompt || item?.currentPrompt || item?.originalPrompt || item || '');
        return `failed prompt ${promptNumber}\n${text}`;
    }).join('\n\n');
}

function buildRetryFlowItem(roundNum, prompts, failedReason = '') {
    const retryCount = Math.max(1, Math.min(3, Number(roundNum) || 1));
    const rules = RETRY_FLOW_RULES[retryCount] || RETRY_FLOW_RULES[1];
    return {
        retry_count: retryCount,
        task: rules.task,
        failed_reason: failedReason || rules.failedReason,
        instruction: rules.instruction,
        prompt: numberedPromptText(prompts)
    };
}

/**
 * Call NVIDIA Qwen API to get a policy-violation-free version of a failed prompt.
 * @param {string} apiKey       - NVIDIA API key (nvapi-...)
 * @param {string} promptText   - Original failed prompt text
 * @param {number} promptNumber - 1-based prompt number (for context in log messages)
 * @param {string} failedReason - Why the prompt failed, when available
 * @returns {Promise<{success: boolean, editedPrompt: string, error: string}>}
 */
export async function callGemini(apiKey, promptText, promptNumber, failedReason = '', roundNum = 1) {
    // Note: function kept as 'callGemini' for backward compatibility with core.js
    if (!apiKey || !promptText) {
        return { success: false, error: 'Missing API key or prompt text' };
    }

    const modelConfig = await getStoredAiRetryModelConfig();
    const userMessage = JSON.stringify({
        retry_flow: [buildRetryFlowItem(roundNum, [{ promptNumber, prompt: promptText }], failedReason)]
    }, null, 2);

    const requestBody = buildChatRequestBody(modelConfig, {
        messages: [
            { role: 'system', content: SYSTEM_PROMPT_V2 },
            { role: 'user',   content: userMessage }
        ],
        temperature: 0.6,
        top_p: 0.8,
        max_tokens: 512,
        stream: false    // streaming not needed for extension use
    });

    try {
        const response = await fetch(buildUrl(), {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            let errMsg = `HTTP ${response.status}`;
            try {
                const errData = await response.json();
                errMsg = errData?.message || errData?.detail || errData?.error?.message || errMsg;
            } catch (_) {}
            return { success: false, error: errMsg };
        }

        const data = await response.json();
        const choice = data?.choices?.[0];

        if (!choice) {
            return { success: false, error: 'Empty response from API' };
        }

        if (choice.finish_reason === 'content_filter') {
            return { success: false, error: 'Model refused this prompt (content filter)' };
        }

        const editedText = choice?.message?.content?.trim();
        if (!editedText) {
            return { success: false, error: 'Empty message content from model' };
        }
        if (!hasMeaningfulEdit(promptText, editedText)) {
            return { success: false, error: 'AI returned the same prompt without a real edit' };
        }

        return { success: true, editedPrompt: editedText, model: modelConfig.model };

    } catch (e) {
        return { success: false, error: `Network error: ${e.message}` };
    }
}

function extractJsonObject(text) {
    const raw = String(text || '').trim();
    if (!raw) throw new Error('Empty response from API');
    try {
        return JSON.parse(raw);
    } catch (_) {
        const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced?.[1]) return JSON.parse(fenced[1].trim());
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
        throw new Error('Response was not valid JSON');
    }
}

/**
 * Repair multiple failed prompts in one NVIDIA Qwen request while preserving prompt numbers.
 * @param {string} apiKey
 * @param {Array<{promptNumber:number,prompt:string,previousEditedPrompt?:string,round?:number}>} failedPrompts
 * @param {number} roundNum
 * @returns {Promise<{success:boolean, edits:Array<{promptNumber:number, editedPrompt:string}>, error?:string}>}
 */
export async function callGeminiBatch(apiKey, failedPrompts, roundNum = 1) {
    if (!apiKey) return { success: false, edits: [], error: 'Missing API key' };
    const modelConfig = await getStoredAiRetryModelConfig();
    const prompts = Array.isArray(failedPrompts) ? failedPrompts.filter(p => p?.prompt) : [];
    if (!prompts.length) return { success: false, edits: [], error: 'No failed prompts to repair' };

    const payload = prompts.map(p => ({
        promptNumber: Number(p.promptNumber),
        failedReason: p.failedReason || p.retryReason || '',
        originalPrompt: String(p.originalPrompt || p.prompt || ''),
        currentPrompt: String(p.prompt || ''),
        previousEditedPrompt: p.previousEditedPrompt || '',
        round: Number(p.round || roundNum || 1)
    }));

    const batchSystemPrompt = `${SYSTEM_PROMPT_V2}

You will receive multiple failed prompts with promptNumber values. Return ONLY valid JSON in this exact shape:
{
  "prompts": [
    { "promptNumber": 5, "editedPrompt": "..." }
  ]
}

Rules for the JSON response:
- Include every promptNumber exactly once.
- Return exactly the same number of edited prompts as you received.
- Do not renumber, reorder meaning, or drop prompts.
- Preserve the same subject, action, camera movement, style, setting, and visual intent.
- Every editedPrompt must contain a real edit; never return an unchanged prompt.
- If this is a later round, make the prompt safer than the previous edit without changing what it is about.`;

    const requestBody = buildChatRequestBody(modelConfig, {
        messages: [
            { role: 'system', content: batchSystemPrompt },
            {
                role: 'user',
                content: JSON.stringify({
                    expected_prompt_count: payload.length,
                    response_contract: {
                        format: 'json',
                        shape: { prompts: [{ promptNumber: 1, editedPrompt: 'rewritten safe prompt' }] },
                        rule: 'Return exactly one rewritten prompt for every promptNumber in the request.'
                    },
                    retry_flow: [
                        buildRetryFlowItem(
                            roundNum,
                            payload.map(p => ({ promptNumber: p.promptNumber, prompt: p.currentPrompt })),
                            payload.map(p => p.failedReason).filter(Boolean).join('; ')
                        )
                    ],
                    previous_edits: payload
                        .filter(p => p.previousEditedPrompt)
                        .map(p => ({ promptNumber: p.promptNumber, previousEditedPrompt: p.previousEditedPrompt }))
                }, null, 2)
            }
        ],
        temperature: 0.7,
        top_p: 0.8,
        max_tokens: 4096,
        stream: false
    });

    try {
        const response = await fetch(buildUrl(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            let errMsg = `HTTP ${response.status}`;
            try {
                const errData = await response.json();
                errMsg = errData?.message || errData?.detail || errData?.error?.message || errMsg;
            } catch (_) {}
            return { success: false, edits: [], error: errMsg };
        }

        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content?.trim();
        const parsed = extractJsonObject(content);
        const edits = Array.isArray(parsed?.prompts) ? parsed.prompts : [];
        const normalized = edits
            .map(item => ({
                promptNumber: Number(item.promptNumber),
                editedPrompt: String(item.editedPrompt || '').trim()
            }))
            .filter(item => Number.isFinite(item.promptNumber) && item.editedPrompt);

        const expected = new Set(payload.map(p => Number(p.promptNumber)));
        const returned = new Set(normalized.map(p => Number(p.promptNumber)));
        const duplicateNumbers = normalized
            .map(item => Number(item.promptNumber))
            .filter((num, index, nums) => nums.indexOf(num) !== index);
        const unexpected = [...returned].filter(num => !expected.has(num));
        const missing = [...expected].filter(num => !returned.has(num));
        if (normalized.length !== payload.length) {
            return {
                success: false,
                edits: normalized,
                error: `Expected ${payload.length} rewritten prompt(s), received ${normalized.length}`
            };
        }
        if (duplicateNumbers.length) {
            return {
                success: false,
                edits: normalized,
                error: `Duplicate edited prompt number(s): ${[...new Set(duplicateNumbers)].join(', ')}`
            };
        }
        if (unexpected.length) {
            return { success: false, edits: normalized, error: `Unexpected edited prompt number(s): ${unexpected.join(', ')}` };
        }
        if (missing.length) {
            return { success: false, edits: normalized, error: `Missing edited prompt(s): ${missing.join(', ')}` };
        }

        const unchanged = normalized.filter(item => {
            const source = payload.find(p => Number(p.promptNumber) === Number(item.promptNumber));
            return !hasMeaningfulEdit(source?.currentPrompt || source?.originalPrompt || '', item.editedPrompt);
        });
        if (unchanged.length) {
            return {
                success: false,
                edits: normalized,
                error: `AI returned unchanged prompt(s): ${unchanged.map(item => item.promptNumber).join(', ')}`
            };
        }

        return { success: true, edits: normalized, model: modelConfig.model };
    } catch (e) {
        return { success: false, edits: [], error: `Network or parse error: ${e.message}` };
    }
}

/**
 * Validate an NVIDIA API key by sending a tiny test request.
 * @param {string} apiKey - NVIDIA API key (should start with "nvapi-")
 * @returns {Promise<{valid: boolean, error: string}>}
 */
export async function validateGeminiApiKey(apiKey, modelId = DEFAULT_AI_RETRY_MODEL) {
    // Note: kept as 'validateGeminiApiKey' for backward compatibility with ui.js
    const key = (apiKey || '').trim();

    if (key.length < 10) {
        return { valid: false, error: 'API key is too short' };
    }

    const modelConfig = getAiRetryModelConfig(modelId);
    const testBody = buildChatRequestBody(modelConfig, {
        messages: [{ role: 'user', content: 'Say ok.' }],
        max_tokens: 4,
        stream: false
    });

    try {
        const response = await fetch(buildUrl(), {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${key}`
            },
            body: JSON.stringify(testBody)
        });

        // 401 = wrong key
        if (response.status === 401) {
            return { valid: false, error: 'Invalid API key - check at build.nvidia.com' };
        }

        // 403 = key exists but no access to this model
        if (response.status === 403) {
            return { valid: false, error: `Access denied for ${modelConfig.label} - make sure your NVIDIA account has model access/credits` };
        }

        // 429 = rate limit — key IS valid
        if (response.status === 429) {
            return { valid: true };
        }

        // 400 may mean key is ok but request issue
        if (response.status === 400) {
            try {
                const data = await response.json();
                const msg = (data?.message || data?.detail || '').toLowerCase();
                if (msg.includes('auth') || msg.includes('key') || msg.includes('token')) {
                    return { valid: false, error: data.message || data.detail || 'Auth error' };
                }
            } catch (_) {}
            return { valid: true }; // 400 but not auth = key is fine
        }

        if (!response.ok) {
            let errMsg = `HTTP ${response.status}`;
            try {
                const data = await response.json();
                errMsg = data?.message || data?.detail || errMsg;
            } catch (_) {}
            return { valid: false, error: errMsg };
        }

        return { valid: true };

    } catch (e) {
        return { valid: false, error: `Connection failed: ${e.message}` };
    }
}
