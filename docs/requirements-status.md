# Матрица требований пилота

Матрица относится к draft реализации и текущим фактическим доказательствам; итоговая передача будет обновлена после завершения оставшихся запусков. Рецензия выполнена implementer.

| Требование | Реализация и доказательство | Состояние |
| --- | --- | --- |
| R-01 GitHub inputs | Source resolver, SHA freeze; approved Java PR13; immutable manifests | проверено |
| R-02 изоляция | Отдельные owner worktrees, controls и disposable course copies | проверено |
| R-03 реальная сборка | Student/full summary, semantic phases/commands, отдельный PL export; navigation not-observed | проверено в объявленном scope |
| R-04 off | Identity TS/Lua, env permissions fixture; lazy Compiler API; никаких агентов/hook/files в owner off | native fixtures и CI прошли |
| R-05 самодостаточность | ABI 1 локально во всех семи installable packages; agents и runtime patches только в Performance | package audit и owner CI |
| R-06 семантика | Values/this/error/nil/async fixtures и native owner checks; strict HTML/ZIP comparison | итоговое сравнение Java outputs ожидает |
| R-07 разметка | 224 операции и явные walk scopes, без ручных таймеров в каждой функции | audit прошёл |
| R-08 подробная карта | TS Compiler API selected scope; Lua hooks с symbol identity; coverage/skipped, strict отказ | native fixtures и выбранные Java traces прошли; последние backend fixes повторяются |
| R-09 счётчики | Calls/walks/handlers/filter_runs раздельно; unknown scopes явны; node_visits=null | fixtures, full summary и synthetic scaling |
| R-10 вложенность | TS AsyncLocalStorage; Lua per-coroutine stacks/creator spans/tail parents; native childEnv | fixtures и boundary checks прошли |
| R-11 часы | TS monotonic wall/calibration uncertainty; Lua CPU пикосекунды→микросекунды; раздельные traces | native fixtures, Perfetto processor/UI |
| R-12 обычный benchmark | Native Hyperfine 2 --shell none; off; подготовка вне интервала; AB/BA | короткие серии завершены, полные выполняются |
| R-13 evidence | Manifests, raw journals/profiles/receipts, summary/coverage/quality, causal map и traces | реализовано; финальный experiment report ожидает |
| R-14 качество | Dropped/incomplete/errors/ABI/protocol/signals invalid; раннее переполнение сохранено, не принято | fixtures и валидные полные summary |
| R-15 проект и owner PR | Новый приватный Performance и пять owner draft PR; Java diagnostic pilot и native owner checks | шесть PR созданы; итоговая acceptance продолжается |
| R-16 overhead ≤1% | Парные ratios, bootstrap 95%, 10 000 resamples seed42, threshold1.01 | AST30/TS30 и full5 каждого профиля INCONCLUSIVE |
| R-17 русский язык | README, отчёты, пояснения и шесть PR описаны по-русски | проверено |
| R-18 Linux local | x86-64, Quarto1.11.5/Deno2.7.14/Pandoc3.10, установленные инструменты вне интервала | native pilot и CI |

Для недоступных значений используются null/unavailable. Полная trace внутренних функций всего Quarto/Pandoc/V8 не заявляется. Отсутствие наблюдения не считается нулём вызовов.
