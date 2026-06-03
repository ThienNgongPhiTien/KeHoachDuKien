import { getContext } from '../../../extensions.js';
import { generateQuietPrompt, eventSource, event_types, substituteParams } from '../../../../script.js';

const PLUGIN_ID  = 'schedule-planner';
const MODAL_ID   = 'sp-modal-root';
const FAB_ID     = 'sp-fab';
const THEME_KEY  = 'sp-theme';
const API_KEY    = 'sp-api-cfg';
const POS_KEY    = 'sp-pos';
const SIZE_KEY   = 'sp-size';
const FAB_KEY    = 'sp-fab-show';
const DRAFTS_KEY = 'sp-drafts-list';

// view: 'user' | 'char'   charName: confirmed char name
function getCacheKey(view, charName) {
    const chatId = getContext().chatId;
    if (!chatId) return null;
    const v = view ?? currentView;
    const c = charName ?? charViewName;
    if (v === 'char' && c) return `sp-cache-${chatId}-char-${c}`;
    return `sp-cache-${chatId}-user`;
}

function loadCachedForCurrentChat(view, charName) {
    const key = getCacheKey(view, charName);
    if (!key) return null;
    try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (saved?.raw) return renderSchedule(saved.raw, saved.userName || 'Người dùng');
    } catch { /* ignore corrupt cache */ }
    return null;
}

let currentTheme   = localStorage.getItem(THEME_KEY) || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'day' : 'night');
let cachedSchedule = null;
let currentRawData = null; // Lưu raw data hiện tại để Save Draft
let currentSubject = null;
let isGenerating   = false;
let settingsOpen   = false;
let dragState      = null;
let resizeState    = null;
let resizeRAF      = null;
let fabDragged     = false;
let fabDragState   = null;
let currentView    = 'user';  // 'user' | 'char'
let charViewName   = null;    // confirmed char name; preserved when switching to user view
const eventDataMap = new Map(); // evId → { ev, dayIndex, startDate }
let selectedEvents = new Set(); // Lưu các ID event được tích chọn

// Cache thông số tạo lịch trình để giữ lại khi bấm nút Tạo lại
let lastGenVal = '7';
let lastGenUnit = 'Ngày';
let lastGenIdea = '';

const isMobile = () => window.innerWidth <= 640;

// ─── Init ─────────────────────────────────────────────────────────────────────

jQuery(async () => {
    injectExtButton();
    injectModal();
    injectFab();
    injectToastContainer();
    // Reset view state and reload cache on chat switch
    eventSource.on(event_types.CHAT_CHANGED, () => {
        currentView  = 'user';
        charViewName = null;
        selectedEvents.clear();
        $('.sp-view-btn').removeClass('sp-view-active');
        $(`.sp-view-btn[data-view="user"]`).addClass('sp-view-active');
        cachedSchedule = loadCachedForCurrentChat();
        if ($(`#${MODAL_ID}`).is(':visible') && !isGenerating) {
            if (cachedSchedule) setBody(cachedSchedule);
            else setBody(`<div class="sp-empty"><i class="fa-regular fa-calendar"></i><p>Chưa có kế hoạch, nhấp vào góc dưới bên phải để tạo</p></div>`);
        }
    });
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', e => {
        if (!localStorage.getItem(THEME_KEY)) applyTheme(e.matches ? 'day' : 'night');
    });
});

// ─── Config helpers ───────────────────────────────────────────────────────────

function loadCfg() { try { return JSON.parse(localStorage.getItem(API_KEY)) || {}; } catch { return {}; } }
function saveCfg(c) { localStorage.setItem(API_KEY, JSON.stringify(c)); }
function maskKey(k) { return k.length <= 8 ? '•'.repeat(k.length) : '•'.repeat(k.length - 4) + k.slice(-4); }
function fabEnabled() { return localStorage.getItem(FAB_KEY) !== 'false'; }

const DEFAULT_PROMPT_TPL = `Vui lòng tạm dừng nhập vai, hãy hoàn thành nhiệm vụ sau với tư cách là trợ lý lập kế hoạch (nội dung chỉ mang tính tham khảo, không xuất hiện trong văn bản chính):
【Quan trọng】Bất kể cốt truyện sử dụng ngôn ngữ nào, tất cả nội dung đầu ra phải sử dụng tiếng Việt (tên người, địa danh có thể giữ nguyên bản gốc).

Dựa trên bối cảnh cốt truyện và thiết lập thế giới, hãy lập kế hoạch dự kiến cho {{days}} tới cho {{subject}}.
Ý tưởng chủ đạo: {{mainIdea}}

【Quy tắc cụ thể】
1. Phân bổ Giai đoạn & Ước lượng thời gian:
   - Nếu là kế hoạch ngắn hạn (Ngày): Chia theo Ngày (VD: Day: Ngày 1, Day: Ngày 2).
   - Nếu là kế hoạch dài hạn (Tháng/Năm): Chia thành các Giai đoạn vĩ mô VÀ BẮT BUỘC ghi rõ ước lượng thời gian (VD: Day: Giai đoạn 1 (Năm 1-2) hoặc Day: Giai đoạn 1 (Tháng 1-3)).
2. Mật độ sự kiện: BẮT BUỘC sắp xếp từ 2 đến 5 sự kiện nhỏ/chi tiết cho MỖI Ngày hoặc MỖI Giai đoạn. Tuyệt đối không được viết gộp 1 sự kiện duy nhất cho cả một giai đoạn dài hạn.
3. Quy chuẩn trường dữ liệu (mỗi dòng một Event):
   Định dạng: Event: type|title|description|time|location|npc_action|risk_tag
   - type: world / major / user / character
   - title: Tiêu đề sự kiện ngắn gọn.
   - description: Hành động cụ thể của {{subject}}. BẮT BUỘC phải bắt đầu bằng 2 từ khóa "Mục tiêu:" và "Kế hoạch:" (VD: "Mục tiêu: Đột phá cảnh giới. Kế hoạch: Bế quan trong động phủ...").
   - time: Thời điểm cụ thể diễn ra sự kiện này (VD: Nếu là ngày thì ghi "Sáng", "Tối". Nếu là giai đoạn thì ghi "Năm thứ 1", "Tháng thứ 2", "Suốt giai đoạn").
   - location: Nơi diễn ra sự kiện.
   - npc_action: Động thái, âm mưu hoặc hỗ trợ từ {{companion}} (NPC).
   - risk_tag: Thẻ đánh giá rủi ro ngắn gọn (VD: [An toàn], [Cửu tử nhất sinh]).

【Định dạng đầu ra (tuân thủ nghiêm ngặt, chỉ xuất ra cấu trúc sau)】
<calendar_widget>
StartDate: YYYY-MM-DD (Nếu không thể xác định mốc thời gian hiện tại thì bỏ qua dòng này)
Day: Ngày 1 (hoặc VD: Giai đoạn 1 (Năm 1-2))
Event: type|title|description|time|location|npc_action|risk_tag
Event: type|title|description|time|location|npc_action|risk_tag
Event: type|title|description|time|location|npc_action|risk_tag
Day: Ngày 2 (hoặc VD: Giai đoạn 2 (Năm 3-5))
Event: type|title|description|time|location|npc_action|risk_tag
Event: type|title|description|time|location|npc_action|risk_tag
</calendar_widget>`;

// ─── Extensions panel ─────────────────────────────────────────────────────────

function injectExtButton() {
    const html = `
        <div id="${PLUGIN_ID}-settings" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Kế hoạch hành động 7 ngày</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="sp-ext-row">
                    <button id="sp-open-btn" class="menu_button menu_button_icon">
                        <i class="fa-solid fa-calendar-days"></i>
                        <span>Mở bảng kế hoạch</span>
                    </button>
                    <label class="sp-toggle-label">
                        <input type="checkbox" id="sp-fab-check" ${fabEnabled() ? 'checked' : ''}>
                        Nút nổi
                    </label>
                </div>
            </div>
        </div>`;
    $('#extensions_settings').append(html);
    $('#sp-open-btn').on('click', openSchedule);
    $('#sp-fab-check').on('change', function () {
        localStorage.setItem(FAB_KEY, this.checked ? 'true' : 'false');
        $(`#${FAB_ID}`).toggle(this.checked);
    });
}

function setExtBtnState(state) {
    const $btn = $('#sp-open-btn');
    $btn.removeClass('sp-btn-generating sp-btn-done');
    if (state) $btn.addClass(`sp-btn-${state}`);
    const $fab = $(`#${FAB_ID} .sp-fab-btn`);
    $fab.removeClass('sp-btn-generating sp-btn-done');
    if (state) $fab.addClass(`sp-btn-${state}`);
    $('.sp-view-toggle').toggleClass('sp-locked', state === 'generating');
}

// ─── FAB ─────────────────────────────────────────────────────────────────────

function injectFab() {
    const savedPos = JSON.parse(localStorage.getItem('sp-fab-pos') || 'null');
    const mobile = isMobile();
    const posStyle = (!mobile && savedPos)
        ? `left:${savedPos.left}px;top:${savedPos.top}px;right:auto;bottom:auto;`
        : '';
    const html = `<div id="${FAB_ID}" style="position:fixed;z-index:2000000;${posStyle}${fabEnabled() ? '' : 'display:none'}">
        <button class="sp-fab-btn sp-${currentTheme}" title="Kế hoạch hành động"
            style="width:44px;height:44px;border-radius:50%;background:#3a3648;color:#d0bcff;border:1.5px solid rgba(208,188,255,0.35);display:flex;align-items:center;justify-content:center;font-size:1rem;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.5);transform:translateZ(0);clip:auto;">
            <i class="fa-solid fa-calendar-days"></i>
        </button>
    </div>`;
    document.documentElement.insertAdjacentHTML('beforeend', html);

    let wasMobile = isMobile();
    window.addEventListener('resize', () => {
        const nowMobile = isMobile();
        if (nowMobile && !wasMobile) {
            const fab = document.getElementById(FAB_ID);
            if (fab) { fab.style.left = ''; fab.style.top = ''; fab.style.right = ''; fab.style.bottom = ''; }
            const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
            if (sheet) { sheet.style.left = ''; sheet.style.top = ''; sheet.style.right = '';
                         sheet.style.transform = ''; sheet.style.width = ''; sheet.style.height = ''; sheet.style.maxHeight = ''; }
        } else if (!nowMobile && wasMobile) {
            const fab = document.getElementById(FAB_ID);
            if (fab) {
                const sp = JSON.parse(localStorage.getItem('sp-fab-pos') || 'null');
                if (sp) {
                    fab.style.left   = Math.min(sp.left, window.innerWidth  - 60) + 'px';
                    fab.style.top    = Math.min(sp.top,  window.innerHeight - 60) + 'px';
                    fab.style.right  = 'auto';
                    fab.style.bottom = 'auto';
                }
            }
        }
        wasMobile = nowMobile;
    });

    $(`#${FAB_ID}`).on('mousedown', function (e) {
        fabDragged = false;
        const el   = document.getElementById(FAB_ID);
        const rect = el.getBoundingClientRect();
        fabDragState = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top };
        $(document)
            .on('mousemove.fabdrag', function (ev) {
                if (!fabDragState) return;
                if (Math.abs(ev.clientX - fabDragState.startX) > 5 || Math.abs(ev.clientY - fabDragState.startY) > 5) fabDragged = true;
                if (!fabDragged) return;
                const f = document.getElementById(FAB_ID);
                f.style.left   = Math.max(0, Math.min(fabDragState.origLeft + ev.clientX - fabDragState.startX, window.innerWidth  - f.offsetWidth))  + 'px';
                f.style.top    = Math.max(0, Math.min(fabDragState.origTop  + ev.clientY - fabDragState.startY, window.innerHeight - f.offsetHeight)) + 'px';
                f.style.right  = 'auto';
                f.style.bottom = 'auto';
            })
            .on('mouseup.fabdrag', onFabDragEnd);
    });
    document.getElementById(FAB_ID).addEventListener('touchstart', function (e) {
        fabDragged = false;
        const el   = document.getElementById(FAB_ID);
        const rect = el.getBoundingClientRect();
        fabDragState = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, origLeft: rect.left, origTop: rect.top };
        document.addEventListener('touchmove', onFabTouchMove, { passive: false });
        document.addEventListener('touchend', onFabDragEnd);
    }, { passive: true });

    $(`#${FAB_ID} .sp-fab-btn`).on('click', function () {
        if (!fabDragged) {
            $(`#${MODAL_ID}`).is(':visible') ? closePanel() : openSchedule();
        }
    });
}

function onFabTouchMove(ev) {
    if (!fabDragState) return;
    const ex = ev.touches[0].clientX;
    const ey = ev.touches[0].clientY;
    if (Math.abs(ex - fabDragState.startX) > 5 || Math.abs(ey - fabDragState.startY) > 5) fabDragged = true;
    if (!fabDragged) return;
    ev.preventDefault();
    const f = document.getElementById(FAB_ID);
    f.style.left   = Math.max(0, Math.min(fabDragState.origLeft + ex - fabDragState.startX, window.innerWidth  - f.offsetWidth))  + 'px';
    f.style.top    = Math.max(0, Math.min(fabDragState.origTop  + ey - fabDragState.startY, window.innerHeight - f.offsetHeight)) + 'px';
    f.style.right  = 'auto';
    f.style.bottom = 'auto';
}
function onFabDragEnd() {
    if (fabDragged) {
        const f = document.getElementById(FAB_ID);
        const r = f.getBoundingClientRect();
        localStorage.setItem('sp-fab-pos', JSON.stringify({ left: r.left, top: r.top }));
    }
    fabDragState = null;
    $(document).off('mousemove.fabdrag mouseup.fabdrag');
    document.removeEventListener('touchmove', onFabTouchMove);
    document.removeEventListener('touchend',  onFabDragEnd);
}

function injectModal() {
    const cfg = loadCfg();
    const hasCustomApi = !!(cfg.url && cfg.key);
    const html = `
        <div id="${MODAL_ID}" class="sp-root sp-${currentTheme}" style="display:none;position:fixed;z-index:2000001">
            <div class="sp-backdrop"></div>
            <div class="sp-sheet">
                <div class="sp-topbar" id="sp-drag-handle">
                    <span class="sp-topbar-title">Kế hoạch</span>
                    <div class="sp-view-toggle">
                        <button class="sp-view-btn sp-view-active" data-view="user" data-sp-tooltip="Thẻ kế hoạch của bạn">Tôi</button>
                        <button class="sp-view-btn" data-view="char" data-sp-tooltip="Thẻ kế hoạch dự kiến của đối phương/NPC">TA</button>
                    </div>
                    <div class="sp-topbar-actions">
                        <button class="sp-icon-btn sp-settings-btn" title="Cài đặt"><i class="fa-solid fa-gear"></i></button>
                        <button class="sp-icon-btn sp-theme-btn"    title="Chuyển đổi giao diện"><i class="fa-solid fa-circle-half-stroke"></i></button>
                        <button class="sp-icon-btn sp-regen-btn"    title="Tạo lại"><i class="fa-solid fa-rotate-right"></i></button>
                        <button class="sp-icon-btn sp-close-btn"    title="Đóng"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>

                <div id="sp-settings-panel" class="sp-settings-panel" style="display:none; overflow-y:auto; max-height:60vh;">
                    <div class="sp-api-notice ${hasCustomApi ? 'sp-notice-ok' : 'sp-notice-warn'}">
                        <i class="fa-solid ${hasCustomApi ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
                        ${hasCustomApi
                            ? 'Đã cấu hình API độc lập, tạo dưới nền không ảnh hưởng đến trò chuyện'
                            : 'Chưa cấu hình API độc lập: Trong quá trình tạo sẽ <b>chiếm dụng kênh trò chuyện</b>, không thể trò chuyện đồng thời'}
                    </div>
                    <p class="sp-cfg-hint">API tùy chỉnh (Để trống sẽ sử dụng mô hình hiện tại của SillyTavern)</p>
                    <input id="sp-cfg-url"   class="sp-input" type="url"
                           placeholder="Base URL, ví dụ: https://api.openai.com/v1"
                           value="${escapeAttr(cfg.url || '')}">
                    <div class="sp-key-row">
                        <input id="sp-cfg-key" class="sp-input sp-key-input" type="password"
                               placeholder="API Key" value="${escapeAttr(cfg.key || '')}">
                        <button id="sp-key-toggle" class="sp-eye-btn"><i class="fa-solid fa-eye"></i></button>
                    </div>
                    <div class="sp-model-row">
                        <input id="sp-cfg-model" class="sp-input sp-model-input" type="text"
                               placeholder="Tên mô hình, ví dụ: gpt-4o-mini"
                               value="${escapeAttr(cfg.model || '')}">
                        <button id="sp-fetch-models" class="sp-fetch-btn" title="Tải danh sách mô hình">
                            <i class="fa-solid fa-list"></i>
                        </button>
                    </div>
                    <label class="sp-stream-row">
                        <input type="checkbox" id="sp-cfg-stream" ${cfg.stream ? 'checked' : ''}>
                        <span class="sp-stream-label">Streaming</span>
                        <span class="sp-stream-hint">Nhận phản hồi dần dần, nhanh hơn với model chậm</span>
                    </label>
                    <p class="sp-cfg-hint" style="margin-top:8px;">Prompt Template (Tùy chỉnh hệ thống prompt)</p>
                    <textarea id="sp-cfg-prompt" class="sp-input" style="height: 120px; resize: vertical;" placeholder="Template mặc định...">${escapeHtml(cfg.promptTpl || DEFAULT_PROMPT_TPL)}</textarea>
                    
                    <button id="sp-cfg-save" class="sp-save-btn" style="margin-top: 8px;"><i class="fa-solid fa-floppy-disk"></i> Lưu</button>
                    <span id="sp-cfg-msg" class="sp-cfg-msg"></span>
                </div>

                <div class="sp-body" id="sp-body" style="position:relative;">
                    <div class="sp-empty"><i class="fa-regular fa-calendar"></i><p>Nhấp vào nút làm mới ở góc trên bên phải để tạo</p></div>
                </div>

                <div class="sp-resize-handle" id="sp-resize-handle">
                    <i class="fa-solid fa-up-right-and-down-left-from-center"></i>
                </div>
            </div>
        </div>`;
    document.documentElement.insertAdjacentHTML('beforeend', html);

    if (cfg.key) $('#sp-cfg-key').val(maskKey(cfg.key)).data('real', cfg.key);

    $(`#${MODAL_ID} .sp-close-btn`).on('click',    closePanel);
    $(`#${MODAL_ID} .sp-theme-btn`).on('click',    toggleTheme);
    $(`#${MODAL_ID} .sp-regen-btn`).on('click',    onRegenClick);
    $(`#${MODAL_ID} .sp-settings-btn`).on('click', toggleSettings);
    $(`#${MODAL_ID} .sp-backdrop`).on('click',     closePanel);

    // View toggle: Tôi / TA
    $(`#${MODAL_ID} .sp-view-toggle`).on('click', '.sp-view-btn', function () {
        if (isGenerating) return;
        const view = $(this).data('view');
        if (view === currentView) return;
        if (view === 'char') {
            if (charViewName) {
                setView('char', charViewName);
                if (cachedSchedule) setBody(cachedSchedule);
                else showEmptyGenerate();
            } else {
                switchToCharView();
            }
        } else {
            setView('user');
            if (cachedSchedule) setBody(cachedSchedule);
            else showEmptyGenerate();
        }
    });

    $('#sp-cfg-save').on('click',      saveSettings);
    $('#sp-key-toggle').on('click',    toggleKeyVisibility);
    $('#sp-fetch-models').on('click',  fetchModels);
    $('#sp-cfg-key')
        .on('focus', () => { const r = $('#sp-cfg-key').data('real'); if (r) $('#sp-cfg-key').val(r); })
        .on('blur',  () => { const r = $('#sp-cfg-key').data('real') || $('#sp-cfg-key').val(); if (r) $('#sp-cfg-key').data('real', r).val(maskKey(r)); });

    $('#sp-body').on('click', '.sp-tab', function () {
        const idx = parseInt($(this).data('day'));
        $('.sp-tab').removeClass('sp-tab-active');
        $(this).addClass('sp-tab-active');
        $('.sp-days-track').css('transform', `translateX(-${idx * 100 / 7}%)`);
    });

    // Handle check box click
    $('#sp-body').on('change', '.sp-event-checkbox', function(e) {
        const evId = $(this).closest('.sp-event').data('ev-id');
        if (this.checked) {
            selectedEvents.add(evId);
            $(this).closest('.sp-event').addClass('sp-event-checked');
        } else {
            selectedEvents.delete(evId);
            $(this).closest('.sp-event').removeClass('sp-event-checked');
        }
        updateMergeBar();
    });

    // Handle merge send button
    $('#sp-body').on('click', '#sp-merge-send-btn', function(e) {
        e.stopPropagation();
        if (selectedEvents.size === 0) return;
        const eventsToSend = Array.from(selectedEvents).map(id => eventDataMap.get(id)).filter(Boolean);
        eventsToSend.sort((a, b) => {
            if (a.dayIndex !== b.dayIndex) return a.dayIndex - b.dayIndex;
            return 0; 
        });
        writeEventToChat(formatEventsForSend(eventsToSend));
        selectedEvents.clear();
        $('.sp-event-checkbox').prop('checked', false);
        $('.sp-event').removeClass('sp-event-checked');
        updateMergeBar();
    });

    // Live Edit ContentEditable Handler
    $('#sp-body').on('blur', '.sp-editable', function() {
        const evId = $(this).closest('.sp-event').data('ev-id');
        const field = $(this).data('field');
        
        let text = "";
        if (field === 'desc') {
            text = $(this).html().replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        } else {
            text = $(this).text().trim(); 
        }

        const data = eventDataMap.get(evId);
        if (data && data.ev) {
            data.ev[field] = text;
        }
    });

    // Prevent enter from making new divs in contenteditable (except description)
    $('#sp-body').on('keydown', '.sp-editable', function(e) {
        const field = $(this).data('field');
        if (e.key === 'Enter' && field !== 'desc') {
            e.preventDefault();
            $(this).blur();
        }
    });

    // Drafts buttons
    $('#sp-body').on('click', '#sp-save-draft', saveCurrentDraft);
    $('#sp-body').on('click', '#sp-view-drafts', showDraftsList);

    $('#sp-drag-handle').on('mousedown', onDragStart);
    document.getElementById('sp-drag-handle').addEventListener('touchstart', onDragStart, { passive: false });
    $('#sp-resize-handle').on('mousedown', onResizeStart);
    document.getElementById('sp-resize-handle').addEventListener('touchstart', onResizeStart, { passive: false });

    restorePositionAndSize();
}

function updateMergeBar() {
    const $bar = $('#sp-merge-bar');
    if (selectedEvents.size > 0) {
        $('#sp-merge-count').text(selectedEvents.size);
        $bar.css({ transform: 'translateY(0)', opacity: 1, pointerEvents: 'auto' });
    } else {
        $bar.css({ transform: 'translateY(100%)', opacity: 0, pointerEvents: 'none' });
    }
}

// ─── View (Tôi / TA) ───────────────────────────────────────────────────────────

function onRegenClick() {
    if (isGenerating) return;
    const key = getCacheKey();
    if (key) localStorage.removeItem(key);
    cachedSchedule = null;
    selectedEvents.clear();
    
    if (currentView === 'char') {
        switchToCharView();
        charViewName = null; 
    } else {
        showEmptyGenerate();
    }
}

function guessCharName(ctx) {
    const msgs = (ctx.chat || []).filter(m => !m.is_user).slice(-20);
    const counts = {};
    for (const m of msgs) {
        const matches = [...(m.mes || '').matchAll(/^([^\s：:「」【\[\n*#]{1,12})[：:]/gm)];
        for (const match of matches) {
            const name = match[1].trim();
            if (name && !/[*#<>{}\[\]|\\]/.test(name)) counts[name] = (counts[name] || 0) + 1;
        }
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] || ctx.name2 || '';
}

function setView(view, charName) {
    currentView = view;
    selectedEvents.clear();
    if (view === 'char') charViewName = charName || null;
    $('.sp-view-btn').removeClass('sp-view-active');
    $(`.sp-view-btn[data-view="${view}"]`).addClass('sp-view-active');
    cachedSchedule = loadCachedForCurrentChat();
}

function switchToCharView() {
    currentView = 'char';
    const ctx     = getContext();
    const guessed = charViewName || guessCharName(ctx);
    setBody(`<div class="sp-char-picker">
        <p class="sp-char-picker-hint"><i class="fa-solid fa-user-pen"></i> Nhập tên nhân vật muốn lên kế hoạch</p>
        <div class="sp-char-picker-row">
            <input id="sp-char-name-input" class="sp-input" type="text"
                   placeholder="Tên nhân vật" value="${escapeAttr(guessed)}">
            <button id="sp-char-name-confirm" class="sp-save-btn">Xác nhận</button>
        </div>
        ${guessed ? `<p class="sp-char-picker-sub">Tự động điền dựa trên đoạn hội thoại gần đây, có thể sửa trực tiếp</p>` : ''}
    </div>`);
    $('.sp-view-btn').removeClass('sp-view-active');
    $(`.sp-view-btn[data-view="char"]`).addClass('sp-view-active');
    $('#sp-char-name-input').off('keydown.charview').on('keydown.charview', e => { if (e.key === 'Enter') confirmCharView(); });
    $('#sp-char-name-confirm').off('click.charview').on('click.charview', confirmCharView);
    setTimeout(() => { $('#sp-char-name-input').focus().select(); }, 50);
}

function confirmCharView() {
    const name = $('#sp-char-name-input').val().trim();
    if (!name) { $('#sp-char-name-input').focus(); return; }
    setView('char', name);
    if (cachedSchedule) {
        setBody(cachedSchedule);
    } else {
        showEmptyGenerate();
    }
}

// ─── Open / close ─────────────────────────────────────────────────────────────

function openSchedule() {
    showPanel();
    if (isGenerating) {
        setBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">Đang lập kế hoạch…</p></div>`);
    } else if (cachedSchedule) {
        setBody(cachedSchedule);
        updateMergeBar();
    } else {
        showEmptyGenerate();
    }
}

function showEmptyGenerate() {
    setBody(`<div class="sp-empty" style="padding: 20px;">
        <i class="fa-regular fa-calendar" style="font-size:2rem; opacity:0.5; margin-bottom:10px;"></i>
        
        <div style="width: 100%; text-align: left; margin-bottom: 15px;">
            <label style="font-size: 0.8rem; color: var(--sp-subtle); display:block; margin-bottom:4px;">Thời gian dự tính:</label>
            <div style="display: flex; gap: 8px;">
                <input id="sp-gen-val" class="sp-input" type="number" value="${escapeAttr(lastGenVal)}" min="1" style="flex: 1; position: relative;" data-sp-tooltip="Nhập số lượng (Ngày: 1-7, Tháng: 1-12, Năm: tùy ý)">
                <select id="sp-gen-unit" class="sp-input" style="width: 110px; position: relative;" data-sp-tooltip="Chọn đơn vị thời gian muốn lên kế hoạch">
                    <option value="Ngày" ${lastGenUnit === 'Ngày' ? 'selected' : ''}>Ngày</option>
                    <option value="Tháng" ${lastGenUnit === 'Tháng' ? 'selected' : ''}>Tháng</option>
                    <option value="Năm" ${lastGenUnit === 'Năm' ? 'selected' : ''}>Năm</option>
                </select>
            </div>
        </div>

        <div style="width: 100%; text-align: left; margin-bottom: 20px;">
            <label style="font-size: 0.8rem; color: var(--sp-subtle); display:block; margin-bottom:4px;">Ý tưởng chủ đạo (Tùy chọn):</label>
            <textarea id="sp-gen-idea" class="sp-input" placeholder="VD: Tập trung bế quan đột phá Trúc Cơ / Thu thập nhu yếu phẩm... (Nếu để trống, AI sẽ tự động phân tích cốt truyện để lên kế hoạch phù hợp)" style="height: 60px; resize: none;">${escapeHtml(lastGenIdea)}</textarea>
        </div>

        <button class="sp-gen-btn" id="sp-gen-now" style="width: 100%;">Lập Kế Hoạch Ngay</button>
    </div>`);

    // Thiết lập logic ràng buộc động cho ô nhập liệu thời gian mới
    $('#sp-gen-unit').on('change', function() {
        const unit = $(this).val();
        const $val = $('#sp-gen-val');
        if (unit === 'Ngày') {
            $val.attr({ min: 1, max: 7 });
            if (parseInt($val.val()) > 7) $val.val(7);
        } else if (unit === 'Tháng') {
            $val.attr({ min: 1, max: 12 });
            if (parseInt($val.val()) > 12) $val.val(12);
        } else if (unit === 'Năm') {
            $val.removeAttr('max').attr({ min: 1 });
        }
    });

    $('#sp-gen-val').on('change blur', function() {
        const unit = $('#sp-gen-unit').val();
        let v = parseInt($(this).val()) || 1;
        if (v < 1) v = 1;
        if (unit === 'Ngày' && v > 7) v = 7;
        if (unit === 'Tháng' && v > 12) v = 12;
        $(this).val(v);
    });

    $('#sp-gen-now').on('click', triggerGenerate);
}

function showPanel() {
    const $root = $(`#${MODAL_ID}`);
    $root.stop(true).css({ display: 'block', opacity: 0 })
         .animate({ opacity: 1 }, 180);
    setTimeout(positionPanel, 0);
}

function closePanel() {
    $(`#${MODAL_ID}`).stop(true).animate({ opacity: 0 }, 150, function () {
        $(this).css('display', 'none');
    });
}

function setBody(html) { 
    $('#sp-body').html(html);
    if(selectedEvents.size > 0 && html.includes('sp-merge-bar')) {
        updateMergeBar();
    }
}

// ─── Draft Management ────────────────────────────────────────────────────────

function saveCurrentDraft() {
    if (!currentRawData || !currentSubject) {
        showToast('Không có dữ liệu để lưu', null, true);
        return;
    }
    
    let defaultName = `Kế hoạch ${currentSubject} - ${new Date().toLocaleDateString()}`;
    let draftName = prompt("Nhập tên cho bản nháp này (để trống sẽ dùng tên mặc định):", defaultName);
    
    if (draftName === null) return; // Hủy lưu
    draftName = draftName.trim() || defaultName;

    const drafts = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '[]');
    drafts.unshift({
        id: Date.now(),
        date: new Date().toLocaleString(),
        subject: currentSubject,
        name: draftName,
        view: currentView,
        raw: currentRawData
    });
    if (drafts.length > 10) drafts.pop(); 
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    showToast('Đã lưu bản nháp thành công!');
}

function showDraftsList() {
    const drafts = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '[]');
    let html = `<div style="padding: 16px; display: flex; flex-direction: column; gap: 10px; height: 100%; overflow-y: auto;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
            <h3 style="margin:0; font-size: 1rem; color: var(--sp-on-surface);">Bản nháp đã lưu</h3>
            <button class="sp-view-btn" id="sp-close-drafts"><i class="fa-solid fa-arrow-left"></i> Quay lại</button>
        </div>`;
    
    if (drafts.length === 0) {
        html += `<p style="color: var(--sp-subtle); font-size:0.85rem; text-align:center; margin-top:30px;">Chưa có bản nháp nào được lưu.</p>`;
    } else {
        html += drafts.map(d => `
            <div class="sp-event" style="cursor:default; display:flex; flex-direction:column; gap:6px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-weight:600; font-size:0.85rem; color:var(--sp-on-surface);">${escapeHtml(d.name || d.subject)}</span>
                    <span style="font-size:0.7rem; color:var(--sp-subtle);">${d.date}</span>
                </div>
                <div style="font-size:0.75rem; color:var(--sp-subtle);">${escapeHtml(d.subject)} (${d.view === 'char' ? 'NPC' : 'Người dùng'})</div>
                <div style="display:flex; gap: 6px; justify-content:flex-end;">
                    <button class="sp-view-btn sp-load-draft-btn" data-id="${d.id}" style="background:var(--sp-primary); color:var(--sp-on-primary);">Tải bản này</button>
                    <button class="sp-view-btn sp-del-draft-btn" data-id="${d.id}" style="color:#cf6679;"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
        `).join('');
    }
    html += `</div>`;
    setBody(html);

    $('#sp-close-drafts').on('click', () => {
        if (cachedSchedule) setBody(cachedSchedule);
        else showEmptyGenerate();
    });

    $('.sp-load-draft-btn').on('click', function() {
        const id = $(this).data('id');
        const draft = drafts.find(d => d.id === id);
        if (draft) {
            currentRawData = draft.raw;
            currentSubject = draft.subject;
            cachedSchedule = renderSchedule(draft.raw, draft.subject);
            setBody(cachedSchedule);
            showToast('Đã tải bản nháp');
        }
    });

    $('.sp-del-draft-btn').on('click', function() {
        const id = $(this).data('id');
        const newDrafts = drafts.filter(d => d.id !== id);
        localStorage.setItem(DRAFTS_KEY, JSON.stringify(newDrafts));
        showDraftsList();
    });
}


// ─── Generation ───────────────────────────────────────────────────────────────

function triggerGenerate() {
    if (isGenerating) return;
    const num = $('#sp-gen-val').val() || '7';
    const unit = $('#sp-gen-unit').val() || 'Ngày';
    const days = `${num} ${unit}`;
    const idea = $('#sp-gen-idea').val() || '';

    // Lưu lại cấu hình gần nhất để khi Regenerate có thể giữ được nội dung
    lastGenVal = num;
    lastGenUnit = unit;
    lastGenIdea = idea;

    const key = getCacheKey();
    if (key) localStorage.removeItem(key);
    cachedSchedule = null;
    selectedEvents.clear();
    isGenerating = true;
    setExtBtnState('generating');
    if (!$(`#${MODAL_ID}`).is(':visible')) showPanel();
    setBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">Đang phân tích & lập kế hoạch ${days}…</p></div>`);
    runGenerate(days, idea);
}

async function runGenerate(days, idea) {
    const viewSnap = currentView;
    const charSnap = charViewName;
    try {
        const ctx      = getContext();
        const userName = ctx.name1 || 'Người dùng';
        const charName = viewSnap === 'char' ? (charSnap || ctx.name2 || 'Nhân vật') : (ctx.name2 || 'Nhân vật');
        const subject  = viewSnap === 'char' ? charName : userName;
        
        const raw      = await generate(ctx, userName, charName, viewSnap, days, idea);
        currentRawData = raw;
        currentSubject = subject;
        const html     = renderSchedule(raw, subject);

        const cacheKey = getCacheKey(viewSnap, charSnap);
        if (cacheKey) localStorage.setItem(cacheKey, JSON.stringify({ raw, userName: subject, ts: Date.now() }));
        isGenerating = false;
        setExtBtnState('done');

        if (viewSnap === 'char') charViewName = charSnap;

        const stillOnView = currentView === viewSnap &&
            (viewSnap !== 'char' || charViewName === charSnap);
        if (stillOnView) {
            cachedSchedule = html;
            if ($(`#${MODAL_ID}`).is(':visible')) setBody(html);
            else showToast('Kế hoạch đã được tạo, nhấp để xem', () => { showPanel(); setBody(html); });
        } else {
            showToast('Kế hoạch đã được tạo, nhấp để xem', () => {
                setView(viewSnap, charSnap);
                cachedSchedule = html;
                showPanel();
                setBody(html);
            });
        }
        setTimeout(() => setExtBtnState(null), 6000);
    } catch (err) {
        isGenerating = false;
        setExtBtnState(null);
        const errHtml = `<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>Tạo thất bại: ${escapeHtml(err.message || 'Lỗi không xác định')}</p><button class="sp-view-btn" onclick="openSchedule()">Quay lại</button></div>`;
        if ($(`#${MODAL_ID}`).is(':visible') && currentView === viewSnap) setBody(errHtml);
        else showToast('Tạo kế hoạch thất bại, vui lòng thử lại', null, true);
    }
}

async function generate(ctx, userName, charName, perspective, days, idea) {
    const cfg = loadCfg();
    if (!cfg.url || !cfg.key) {
        if (!settingsOpen) toggleSettings();
        throw new Error('Vui lòng điền URL và Key của API tùy chỉnh trong Cài đặt trước');
    }
    const prompt = buildPrompt(userName, charName, perspective, days, idea, cfg.promptTpl);
    return callCustomApi(ctx, prompt, cfg, userName, charName);
}

async function callCustomApi(ctx, prompt, cfg, userName, charName) {
    const messages = buildMessages(ctx, prompt, userName, charName);
    const useStream = !!cfg.stream;
    const res = await fetch(`${cfg.url}/chat/completions`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
        body   : JSON.stringify({ model: cfg.model || 'gpt-4o-mini', messages, max_tokens: 94096, stream: useStream }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`);
    if (!useStream) return (await res.json()).choices?.[0]?.message?.content ?? '';

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let result = '';
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); 
        for (const line of lines) {
            const t = line.trim();
            if (!t || t === 'data: [DONE]') continue;
            if (t.startsWith('data: ')) {
                try { result += JSON.parse(t.slice(6)).choices?.[0]?.delta?.content ?? ''; } catch { /* skip */ }
            }
        }
    }
    return result;
}

function buildMessages(ctx, prompt, userName, charName) {
    const char = ctx.characters?.[ctx.characterId] ?? {};
    const sys  = [`Bạn đang đóng vai ${charName}.`, char.description,
        char.personality ? `【Tính cách】${char.personality}` : '',
        char.scenario    ? `【Bối cảnh】${char.scenario}`    : '',
    ].filter(Boolean).join('\n\n');
    const history = (ctx.chat ?? []).slice(-40).map(m => ({
        role   : m.is_user ? 'user' : 'assistant',
        content: substituteParams(m.mes ?? ''),
    }));
    return [{ role: 'system', content: sys }, ...history, { role: 'user', content: prompt }];
}

function buildPrompt(userName, charName, perspective, days, idea, customTpl) {
    const subject   = perspective === 'char' ? charName : userName;
    const companion = perspective === 'char' ? userName : charName;
    const ideaText  = idea ? idea : "Tự suy luận hợp lý dựa trên diễn biến hiện tại.";
    
    let tpl = customTpl ? customTpl : DEFAULT_PROMPT_TPL;
    tpl = tpl.replace(/\{\{days\}\}/g, days);
    tpl = tpl.replace(/\{\{subject\}\}/g, subject);
    tpl = tpl.replace(/\{\{companion\}\}/g, companion);
    tpl = tpl.replace(/\{\{mainIdea\}\}/g, ideaText);
    
    return tpl;
}

// ─── Settings ─────────────────────────────────────────────────────────────────

async function fetchModels() {
    const url = $('#sp-cfg-url').val().trim().replace(/\/$/, '');
    const key = ($('#sp-cfg-key').data('real') || $('#sp-cfg-key').val()).trim();
    if (!url || !key) { showToast('Vui lòng điền URL và Key trước', null, true); return; }

    const $btn = $('#sp-fetch-models');
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
    try {
        const res = await fetch(`${url}/models`, {
            headers: { 'Authorization': `Bearer ${key}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const models = (data.data || data.models || [])
            .map(m => (typeof m === 'string' ? m : m.id))
            .filter(Boolean).sort();
        if (!models.length) throw new Error('Giao diện không trả về bất kỳ mô hình nào');

        const current = loadCfg().model || '';
        const opts = models.map(m =>
            `<option value="${escapeAttr(m)}"${m === current ? ' selected' : ''}>${escapeHtml(m)}</option>`
        ).join('');
        $('#sp-cfg-model').replaceWith(
            `<select id="sp-cfg-model" class="sp-input sp-model-input">${opts}</select>`
        );
        if (!current) $('#sp-cfg-model').val(models[0]);
        showToast(`Đã tải ${models.length} mô hình`);
    } catch (err) {
        showToast(`Tải mô hình thất bại: ${err.message}`, null, true);
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-list"></i>');
    }
}

function toggleSettings() {
    settingsOpen = !settingsOpen;
    $('#sp-settings-panel').slideToggle(200);
    $(`#${MODAL_ID} .sp-settings-btn`).toggleClass('sp-btn-active', settingsOpen);
}

function toggleKeyVisibility() {
    const $el = $('#sp-cfg-key'), $icon = $('#sp-key-toggle i');
    if ($el.attr('type') === 'password') {
        $el.attr('type', 'text').val($el.data('real') || $el.val());
        $icon.removeClass('fa-eye').addClass('fa-eye-slash');
    } else {
        const r = $el.val(); $el.data('real', r).attr('type', 'password').val(maskKey(r));
        $icon.removeClass('fa-eye-slash').addClass('fa-eye');
    }
}

function saveSettings() {
    const $k = $('#sp-cfg-key'), key = ($k.data('real') || $k.val()).trim();
    saveCfg({ 
        url: $('#sp-cfg-url').val().trim().replace(/\/$/, ''), 
        key, 
        model: $('#sp-cfg-model').val().trim(), 
        stream: $('#sp-cfg-stream').prop('checked'),
        promptTpl: $('#sp-cfg-prompt').val()
    });
    $k.data('real', key).val(maskKey(key)).attr('type', 'password');
    const $m = $('#sp-cfg-msg'); $m.text('Đã lưu ✓'); setTimeout(() => $m.text(''), 2000);
    const hasApi = !!(loadCfg().url && loadCfg().key);
    $('.sp-api-notice')
        .removeClass('sp-notice-ok sp-notice-warn')
        .addClass(hasApi ? 'sp-notice-ok' : 'sp-notice-warn')
        .html(`<i class="fa-solid ${hasApi ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
            ${hasApi ? 'Đã cấu hình API độc lập, tạo dưới nền không ảnh hưởng đến trò chuyện'
                     : 'Chưa cấu hình API độc lập: Trong quá trình tạo sẽ <b>chiếm dụng kênh trò chuyện</b>'}`);
    setTimeout(() => { if (settingsOpen) toggleSettings(); }, 400);
}

function applyTheme(theme) {
    currentTheme = theme;
    $(`#${MODAL_ID}`).removeClass('sp-night sp-day').addClass(`sp-${theme}`);
    $(`#${FAB_ID} .sp-fab-btn`).removeClass('sp-night sp-day').addClass(`sp-${theme}`);
}

function toggleTheme() {
    applyTheme(currentTheme === 'night' ? 'day' : 'night');
    localStorage.setItem(THEME_KEY, currentTheme);
}

// ─── Drag ─────────────────────────────────────────────────────────────────────

function onDragStart(e) {
    if ($(e.target).closest('.sp-icon-btn, .sp-view-btn').length) return;
    e.preventDefault();
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    const rect  = sheet.getBoundingClientRect();
    if (sheet.style.transform !== 'none' && (sheet.style.left === '' || sheet.style.left === '50%')) {
        sheet.style.transform = 'none';
        sheet.style.left = rect.left + 'px';
        sheet.style.top  = rect.top  + 'px';
    }
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    dragState = { startX: cx, startY: cy, origLeft: rect.left, origTop: rect.top };
    $(document).on('mousemove.spdrag', onDragMove).on('mouseup.spdrag', onDragEnd);
    document.addEventListener('touchmove', onDragMove, { passive: false });
    document.addEventListener('touchend',  onDragEnd);
    $('#sp-drag-handle').css('cursor', 'grabbing');
}

function onDragMove(e) {
    if (!dragState) return;
    e.preventDefault();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    const left = Math.max(0, Math.min(dragState.origLeft + cx - dragState.startX, window.innerWidth  - sheet.offsetWidth));
    const top  = Math.max(0, Math.min(dragState.origTop  + cy - dragState.startY, window.innerHeight - 60));
    sheet.style.left  = left + 'px';
    sheet.style.top   = top  + 'px';
    sheet.style.right = 'auto';
}

function onDragEnd() {
    if (!dragState) return;
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    const rect  = sheet.getBoundingClientRect();
    if (!isMobile()) {
        localStorage.setItem(POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    }
    dragState = null;
    $(document).off('mousemove.spdrag mouseup.spdrag');
    document.removeEventListener('touchmove', onDragMove);
    document.removeEventListener('touchend',  onDragEnd);
    $('#sp-drag-handle').css('cursor', 'grab');
}

// ─── Resize ───────────────────────────────────────────────────────────────────

function onResizeStart(e) {
    e.preventDefault();
    e.stopPropagation();
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    sheet.style.willChange = 'width, height';
    document.body.style.userSelect = 'none';
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    resizeState = {
        startX: cx, startY: cy,
        origW : sheet.offsetWidth, origH : sheet.offsetHeight,
    };
    $(document).on('mousemove.spresize', onResizeMove).on('mouseup.spresize', onResizeEnd);
    document.addEventListener('touchmove', onResizeMove, { passive: false });
    document.addEventListener('touchend',  onResizeEnd);
}

function onResizeMove(e) {
    if (!resizeState) return;
    e.preventDefault();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    if (resizeRAF) return;
    resizeRAF = requestAnimationFrame(() => {
        resizeRAF = null;
        const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
        const w = Math.max(280, Math.min(700, resizeState.origW + cx - resizeState.startX));
        const h = Math.max(300, Math.min(window.innerHeight * 0.92, resizeState.origH + cy - resizeState.startY));
        sheet.style.width     = w + 'px';
        sheet.style.height    = h + 'px';
        sheet.style.maxHeight = h + 'px';
    });
}

function onResizeEnd() {
    if (!resizeState) return;
    if (resizeRAF) { cancelAnimationFrame(resizeRAF); resizeRAF = null; }
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    sheet.style.willChange = '';
    document.body.style.userSelect = '';
    localStorage.setItem(SIZE_KEY, JSON.stringify({ width: sheet.offsetWidth, height: sheet.offsetHeight }));
    resizeState = null;
    $(document).off('mousemove.spresize mouseup.spresize');
    document.removeEventListener('touchmove', onResizeMove);
    document.removeEventListener('touchend',  onResizeEnd);
}

function restorePositionAndSize() {
    setTimeout(() => {
        const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
        if (!sheet) return;
        const pos  = JSON.parse(localStorage.getItem(POS_KEY)  || 'null');
        const size = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
        if (pos) {
            sheet.style.left  = Math.min(pos.left, window.innerWidth  - sheet.offsetWidth)  + 'px';
            sheet.style.top   = Math.min(pos.top,  window.innerHeight - 60) + 'px';
            sheet.style.right = 'auto';
        }
        if (size) {
            sheet.style.width     = size.width  + 'px';
            sheet.style.height    = size.height + 'px';
            sheet.style.maxHeight = size.height + 'px';
        }
    }, 0);
}

function positionPanel() {
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    if (!sheet) return;
    if (isMobile()) {
        sheet.style.left      = '';
        sheet.style.top       = '';
        sheet.style.right     = '';
        sheet.style.transform = '';
        return;
    }
    const pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (pos) {
        sheet.style.left  = Math.min(pos.left, window.innerWidth  - sheet.offsetWidth)  + 'px';
        sheet.style.top   = Math.min(pos.top,  window.innerHeight - 60) + 'px';
        sheet.style.right = 'auto';
    }
}

// ─── Toast (top) ──────────────────────────────────────────────────────────────

function injectToastContainer() {
    if (!$('#sp-toast-wrap').length) document.documentElement.insertAdjacentHTML('beforeend', '<div id="sp-toast-wrap"></div>');
}

function showToast(msg, onClick, isError = false) {
    const $t = $(`<div class="sp-toast${isError ? ' sp-toast-error' : ''}">
        <i class="fa-solid ${isError ? 'fa-circle-exclamation' : 'fa-calendar-check'}"></i>
        <span>${escapeHtml(msg)}</span>
    </div>`);
    $('#sp-toast-wrap').append($t);
    requestAnimationFrame(() => $t.addClass('sp-toast-show'));
    if (onClick) $t.css('cursor', 'pointer').on('click', () => { onClick(); $t.remove(); });
    setTimeout(() => { $t.removeClass('sp-toast-show'); setTimeout(() => $t.remove(), 350); }, 4000);
}

// ─── Rendering ────────────────────────────────────────────────────────────────

const TYPE_META = {
    world    : { icon: 'fa-earth-asia', label: 'Thế giới',  cls: 'sp-type-world'     },
    major    : { icon: 'fa-star',       label: 'Sự kiện lớn',  cls: 'sp-type-major'     },
    user     : { icon: 'fa-user',       label: 'Cá nhân',  cls: 'sp-type-user'       },
    character: { icon: 'fa-heart',      label: 'NPC',   cls: 'sp-type-character' },
};

function renderSchedule(raw, userName) {
    eventDataMap.clear();
    const { days, startDate } = parseCalendar(raw);
    if (days.length === 0) return `<div class="sp-raw">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;

    const WEEKDAYS = ['CN','T2','T3','T4','T5','T6','T7'];

    const header = `<div class="sp-schedule-header" style="justify-content: space-between;">
        <div>
            <span class="sp-user-chip">${escapeHtml(userName)}</span>
            <span class="sp-schedule-label"> - Kế hoạch ${days.length} mốc</span>
        </div>
        <div style="display:flex; gap:4px;">
            <button class="sp-view-btn" id="sp-save-draft" title="Lưu nháp"><i class="fa-solid fa-bookmark"></i></button>
            <button class="sp-view-btn" id="sp-view-drafts" title="Xem bản nháp"><i class="fa-solid fa-folder-open"></i></button>
        </div>
    </div>`;

    const tabs = days.map((day, i) => {
        let numLabel = day.label || String(i + 1);
        let wdLabel = '';
        if (startDate && !day.label.match(/[a-zA-Z]/)) { // Chỉ format thứ nếu là số ngày thuần túy
            const d = new Date(startDate);
            d.setDate(d.getDate() + i);
            wdLabel  = WEEKDAYS[d.getDay()];
            numLabel = `${d.getDate()}/${d.getMonth() + 1}`; 
        }
        return `<button class="sp-tab${i === 0 ? ' sp-tab-active' : ''}" data-day="${i}">
            <span class="sp-tab-num" style="white-space: normal; line-height: 1.2;">${escapeHtml(numLabel)}</span>
            ${wdLabel ? `<span class="sp-tab-wd">${wdLabel}</span>` : ''}
        </button>`;
    }).join('');

    const panels = days.map((day, dayIndex) =>
        `<div class="sp-day-panel" style="width: calc(100% / ${days.length}); padding-bottom: 60px;">${day.events.map((ev, evIdx) => renderEvent(ev, dayIndex, evIdx, startDate)).join('')}</div>`
    ).join('');

    const mergeBar = `
        <div id="sp-merge-bar" style="
            position: absolute; bottom: 0; left: 0; right: 0; 
            background: var(--sp-surface-high); border-top: 1px solid var(--sp-divider);
            padding: 10px 16px; display: flex; justify-content: space-between; align-items: center;
            transform: translateY(100%); opacity: 0; transition: transform 0.2s, opacity 0.2s;
            pointer-events: none; z-index: 10; box-shadow: 0 -2px 10px rgba(0,0,0,0.2);">
            <span style="font-size: 0.85rem; color: var(--sp-on-surface);"><span id="sp-merge-count">0</span> sự kiện</span>
            <button id="sp-merge-send-btn" class="sp-send-btn"><i class="fa-solid fa-paper-plane"></i> Gửi lệnh gộp</button>
        </div>
    `;

    return `${header}<div class="sp-tab-bar">${tabs}</div>
        <div class="sp-days-wrap" style="position:relative;">
            <div class="sp-days-track" style="width: ${days.length * 100}%;">${panels}</div>
            ${mergeBar}
        </div>`;
}

function parseCalendar(raw) {
    const m = raw.match(/<calendar_widget[^>]*>([\s\S]*?)<\/calendar_widget>/i);
    const content = m ? m[1] : raw;

    const dateMatch = content.match(/^StartDate:\s*(\d{4}-\d{2}-\d{2})/m);
    let startDate = null;
    if (dateMatch) {
        const d = new Date(dateMatch[1]);
        if (!isNaN(d)) startDate = d;
    }

    const days = []; let cur = null;
    for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('<!--')) continue;
        
        // Hỗ trợ parse định dạng Mốc thời gian mới (Tháng, Giai đoạn, Ngày...)
        if (/^Day\s*:?/i.test(t) || /^第[一二三四五六七\d]+/.test(t) || /^Giai đoạn/i.test(t) || /^Tháng/i.test(t)) {
            if (cur) days.push(cur); 
            // Lưu lại label của mốc thời gian thay vì chỉ lưu event
            cur = { label: t.replace(/^Day\s*:\s*/i, ''), events: [] }; 
            continue;
        }
        
        if (/^Event\s*:/i.test(t)) {
            if (!cur) cur = { label: '1', events: [] };
            const parts = t.replace(/^Event\s*:\s*/i, '').split('|');
            if (parts.length >= 4) cur.events.push({
                type: (parts[0]||'user').trim().toLowerCase(), 
                title: (parts[1]||'').trim(),
                desc: (parts[2]||'').trim(), 
                time: (parts[3]||'').trim(),
                location: (parts[4]||'').trim(), 
                npcAction: (parts[5]||'').trim(),
                riskTag: (parts[6]||'').trim()
            });
        }
    }
    if (cur) days.push(cur);
    return { days: days.filter(d => d.events.length > 0), startDate };
}

function renderEvent(ev, dayIndex, evIdx, startDate) {
    const evId = `spev-${dayIndex}-${evIdx}`;
    eventDataMap.set(evId, { ev, dayIndex, startDate });
    const meta = TYPE_META[ev.type] || TYPE_META.user;
    
    // Giữ nguyên các thẻ xuống dòng nếu có, đồng thời tách dòng "Kế hoạch:" xuống
    let formattedDesc = escapeHtml(ev.desc)
        .replace(/(\n|\\n)/g, '<br>')
        .replace(/(Kế hoạch:)/g, '<br>$1');

    return `<div class="sp-event ${meta.cls}" data-ev-id="${evId}" style="position: relative;">
        <div class="sp-event-head">
            <span class="sp-type-badge"><i class="fa-solid ${meta.icon}"></i>${escapeHtml(meta.label)}</span>
            <span class="sp-event-title sp-editable" contenteditable="true" data-field="title">${escapeHtml(ev.title)}</span>
            ${ev.time ? `<span class="sp-event-time sp-editable" contenteditable="true" data-field="time"><i class="fa-regular fa-clock"></i> ${escapeHtml(ev.time)}</span>` : ''}
        </div>

        <div style="position: absolute; top: 10px; right: 16px; display:flex; flex-direction:column; align-items:center;">
            <label style="font-size:0.6rem; color:var(--sp-subtle); margin-bottom:2px; cursor:pointer;">Duyệt</label>
            <input type="checkbox" class="sp-event-checkbox" style="width: 18px; height: 18px; cursor: pointer; accent-color: #66bb6a;">
        </div>

        ${ev.desc ? `<p class="sp-event-desc sp-editable" contenteditable="true" data-field="desc" style="padding-right: 45px;">${formattedDesc}</p>` : ''}
        
        <div class="sp-event-meta">
            ${ev.location  ? `<span class="sp-event-loc">Địa điểm：<span class="sp-editable" contenteditable="true" data-field="location">${escapeHtml(ev.location)}</span></span>` : ''}
            ${ev.npcAction ? `<span class="sp-event-npc">Phân công/NPC：<span class="sp-editable" contenteditable="true" data-field="npcAction">${escapeHtml(ev.npcAction)}</span></span>` : ''}
        </div>
    </div>`;
}

// Xử lý gửi lệnh gộp vào ST - Cấu trúc lại và loại bỏ thẻ rủi ro
function formatEventsForSend(eventItems) {
    let combinedText = `[Chỉ thị Tối cao]: Đây là toàn bộ kế hoạch dự tính của ${currentView === 'char' ? 'NPC' : 'tôi'} cho giai đoạn tới, chúng ta sẽ bắt đầu thực hiện theo các kế hoạch này:\n\n`;
    
    eventItems.forEach((item, index) => {
        const { ev, dayIndex } = item;
        let dateLabel = ev.dayLabel || `Ngày ${dayIndex + 1}`;
        if (/^\d+$/.test(dateLabel)) dateLabel = `Ngày ${dateLabel}`; // Cố định prefix nếu chỉ là số
        
        const locPart = ev.location ? ` tại [${ev.location}]` : '';
        
        // Ép xuống dòng Kế hoạch khi nạp vào Chat
        let actionDesc = ev.desc.replace(/(Kế hoạch:)/gi, '\n   - $1');
        // Nếu Live Edit sinh ra thẻ <br>, đổi lại thành dấu Enter
        actionDesc = actionDesc.replace(/<br\s*\/?>/gi, '\n   ');

        combinedText += `📍 ${index + 1}. [${dateLabel} - ${ev.time || '?'}]${locPart} : "${ev.title}"\n`;
        combinedText += `   - Hành động: ${actionDesc}\n`;
        if (ev.npcAction) combinedText += `   - Động thái đồng minh/NPC: ${ev.npcAction}\n`;
        // Đã xóa dòng lưu ý Thẻ rủi ro theo yêu cầu
        combinedText += `\n`;
    });
    
    return combinedText.trim();
}

function writeEventToChat(text) {
    const ta = document.getElementById('send_textarea');
    if (!ta) { showToast('Không tìm thấy khung chat của SillyTavern', null, true); return; }
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(ta, text); else ta.value = text;
    ta.dispatchEvent(new Event('input',  { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    ta.focus();
    showToast('Đã nạp kế hoạch vào khung chat! Nhấn Enter để gửi~ ✨');
}

function escapeHtml(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escapeAttr(s)  { return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
