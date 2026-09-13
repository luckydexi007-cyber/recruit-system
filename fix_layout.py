# -*- coding: utf-8 -*-
p = "/mnt/cos/artifacts/recruit/public/index.html"
s = open(p, encoding="utf-8").read()

def rep(old, new):
    global s
    n = s.count(old)
    assert n == 1, "count %d for: %r" % (n, old[:90])
    s = s.replace(old, new)
    print("OK:", old[:70])

# 1) 渲染模板：嵌套 div → 纯 span（零嵌套，杜绝套娃）
old_label = ('<label class="checkbox-item"><div class="cb-box">✓</div><div class="cb-order"></div>'
             '<div style="flex:1"><div class="cb-label">${d.icon} ${d.name}</div></div>'
             '<input type="checkbox" class="dept-check hidden" value="${d.name}"></label>')
new_label = ('<label class="checkbox-item"><input type="checkbox" class="dept-check hidden" value="${d.name}">'
             '<span class="cb-box">✓</span><span class="cb-order"></span>'
             '<span class="cb-label">${d.icon} ${d.name}</span></label>')
rep(old_label, new_label)

# 2) 网格布局：固定 2 列 → 自适应多列（窄屏 2 列、宽屏 3 列，永不挤成一条）
rep('.checkbox-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
    '.checkbox-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}')

# 3) cb-box 作为 span 需要 flex 居中
rep('.checkbox-item .cb-box{width:20px;height:20px;border-radius:4px;',
    '.checkbox-item .cb-box{display:flex;align-items:center;justify-content:center;flex-shrink:0;width:20px;height:20px;border-radius:4px;')

# 4) cb-label 作为 span：确保不换行截断
rep('.checkbox-item .cb-label{font-size:13px;font-weight:500}',
    '.checkbox-item .cb-label{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}')

open(p, "w", encoding="utf-8").write(s)
print("SAVED len=", len(s))
