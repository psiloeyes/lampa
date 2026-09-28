(function () {
    'use strict';

    // Рейтинг на постерах: IMDb / Lampa / КП вместо TMDB (Lampa 3.x)
    if (window.poster_rating_plugin) return;
    window.poster_rating_plugin = true;

    var CACHE_NAME = 'poster_rating_lampa';
    var CACHE_LIMIT = 3000;
    var CACHE_TTL = 1000 * 60 * 60 * 24;
    var MAX_REQUESTS = 4;

    var network = new Lampa.Reguest();
    var cache = Lampa.Storage.get(CACHE_NAME, '{}') || {};
    var save_timer;
    var queue = [];
    var waiting = {};
    var active = 0;

    function mode() {
        return Lampa.Storage.field('poster_rating_source');
    }

    function num(value) {
        var n = parseFloat(value);
        return isNaN(n) || n <= 0 ? 0 : n;
    }

    function lampaKey(data) {
        if (!data.id || (data.source && data.source != 'tmdb' && data.source != 'cub')) return '';
        return (data.original_name ? 'tv' : 'movie') + '_' + data.id;
    }

    function saveCache() {
        clearTimeout(save_timer);
        save_timer = setTimeout(function () {
            var keys = Object.keys(cache);
            if (keys.length > CACHE_LIMIT) {
                keys.slice(0, keys.length - CACHE_LIMIT).forEach(function (k) {
                    delete cache[k];
                });
            }
            Lampa.Storage.set(CACHE_NAME, cache);
        }, 3000);
    }

    function cached(key) {
        var item = cache[key];
        if (item && Date.now() - item.t < CACHE_TTL) return item;
        return null;
    }

    // Та же формула, что в плагине «Рейтинг Lampa»
    function calcLampa(json) {
        var pos = 0, neg = 0;
        (json && json.result || []).forEach(function (r) {
            var c = parseInt(r.counter, 10) || 0;
            if (r.type == 'fire' || r.type == 'nice') pos += c;
            if (r.type == 'think' || r.type == 'bore' || r.type == 'shit') neg += c;
        });
        return pos + neg > 0 ? pos / (pos + neg) * 10 : 0;
    }

    function next() {
        while (active < MAX_REQUESTS && queue.length) {
            (function (key) {
                active++;
                var done = function (value, ok) {
                    active--;
                    if (ok) {
                        cache[key] = { v: value, t: Date.now() };
                        saveCache();
                    }
                    var list = waiting[key] || [];
                    delete waiting[key];
                    list.forEach(function (cb) { cb(value); });
                    next();
                };
                var url = Lampa.Utils.protocol() + Lampa.Manifest.cub_domain + '/api/reactions/get/' + key;
                network.silent(url, function (json) {
                    done(calcLampa(json), true);
                }, function () {
                    done(0, false);
                }, false, { timeout: 1000 * 10 });
            })(queue.pop());
        }
    }

    function loadLampa(key, cb) {
        if (waiting[key]) return waiting[key].push(cb);
        waiting[key] = [cb];
        queue.push(key);
        next();
    }

    function draw(html, value, is_fallback) {
        var view = html && html.querySelector && html.querySelector('.card__view');
        if (!view) return;
        var old = view.querySelector('.card__vote');
        if (!value) {
            if (old) old.parentNode.removeChild(old);
            return;
        }
        var el = old || document.createElement('div');
        el.className = 'card__vote' + (is_fallback ? ' card__vote--fallback' : '');
        el.textContent = value >= 10 ? '10' : value.toFixed(1);
        if (!old) view.appendChild(el);
    }

    function fallbackValue(data) {
        return Lampa.Storage.field('poster_rating_fallback') == 'tmdb' ? num(data.cub_hundred_rating || data.vote_average) : 0;
    }

    // Отрисовать рейтинг; visible = карточку видно, можно делать запрос
    function apply(html, data, visible) {
        var m = mode();
        if (!data || data.cub_hundred_fire || m == 'tmdb') return; // «Огонь!» и TMDB не трогаем
        if (m == 'none') return draw(html, 0);

        var value = 0;
        if (m == 'imdb') value = num(data.imdb_rating);
        if (m == 'kp') value = num(data.kp_rating);

        if (m == 'lampa') {
            var key = lampaKey(data);
            var item = key && cached(key);
            if (item) value = item.v;
            else if (key) {
                draw(html, fallbackValue(data), true);
                if (visible) loadLampa(key, function (v) {
                    if (mode() == 'lampa') draw(html, v || fallbackValue(data), !v);
                });
                return;
            }
        }

        if (value) draw(html, value, false);
        else draw(html, fallbackValue(data), true);
    }

    function hookMaker() {
        var ratting = Lampa.Maker && Lampa.Maker.map && Lampa.Maker.map('Card').Ratting;
        if (!ratting) return false;

        var onCreate = ratting.onCreate;
        var onVisible = ratting.onVisible;

        ratting.onCreate = function () {
            if (onCreate) onCreate.apply(this, arguments);
            apply(this.html, this.data, false);
        };
        ratting.onVisible = function () {
            if (onVisible) onVisible.apply(this, arguments);
            if (mode() == 'lampa') apply(this.html, this.data, true);
        };
        return true;
    }

    // Перерисовать уже показанные карточки после смены настройки
    function refreshAll() {
        var cards = document.querySelectorAll('.card');
        for (var i = 0; i < cards.length; i++) {
            var data = cards[i].card_data;
            if (!data) continue;
            if (mode() == 'tmdb') {
                var v = num(data.cub_hundred_rating || data.vote_average);
                if (!data.cub_hundred_fire) draw(cards[i], v, false);
            } else apply(cards[i], data, true);
        }
    }

    function addSettings() {
        Lampa.SettingsApi.addParam({
            component: 'interface',
            param: {
                name: 'poster_rating_source',
                type: 'select',
                values: {
                    imdb: 'IMDb',
                    lampa: 'Lampa',
                    kp: 'Кинопоиск',
                    tmdb: 'TMDB (стандартно)',
                    none: 'Скрыть'
                },
                default: 'imdb'
            },
            field: {
                name: 'Рейтинг на постерах',
                description: 'Какой рейтинг показывать в углу постера'
            },
            onChange: refreshAll
        });
        Lampa.SettingsApi.addParam({
            component: 'interface',
            param: {
                name: 'poster_rating_fallback',
                type: 'select',
                values: {
                    tmdb: 'Показать TMDB (бледным)',
                    none: 'Ничего не показывать'
                },
                default: 'tmdb'
            },
            field: {
                name: 'Если рейтинга нет',
                description: 'Что показывать, когда у фильма нет выбранного рейтинга'
            },
            onChange: refreshAll
        });

        var style = document.createElement('style');
        style.textContent = '.card__vote--fallback{opacity:.55}';
        document.head.appendChild(style);
    }

    function start() {
        addSettings();
        if (!hookMaker()) Lampa.Noty.show('Рейтинг на постерах: нужна Lampa 3.x');
    }

    if (window.appready) start();
    else Lampa.Listener.follow('app', function (e) {
        if (e.type == 'ready') start();
    });
})();
