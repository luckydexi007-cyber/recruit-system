# -*- coding: utf-8 -*-
p="/mnt/cos/artifacts/recruit/public/index.html"
s=open(p,encoding="utf-8").read()
anchor = '<div class="tab-bar"><button class="${CURRENT_TAB===\'pending\'?\'active\':\'\'}" data-atab="pending">'
assert s.count(anchor)==1, "anchor count %d"%s.count(anchor)

block = ('<div class="card" style="margin-bottom:20px;padding:16px">'
 '<div style="font-size:14px;font-weight:600;margin-bottom:12px">🏛️ 六部门录取人数统计</div>'
 '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px">'
 '${ALL_DEPT_NAMES.map(dn=>{const c=admitted.filter(r=>r.admittedDepartment===dn).length;'
 'const t=resumes.filter(r=>(r.departments||[]).includes(dn)).length;'
 'return `<div style="text-align:center;padding:12px;background:var(--intensity-4);border-radius:var(--radius-md)">'
 '<div style="font-size:22px;font-weight:600;color:var(--primary)">${c}</div>'
 '<div style="font-size:12px;font-weight:500;margin-top:2px">${dn}</div>'
 '<div style="font-size:11px;color:var(--text-tertiary);margin-top:2px">意向 ${t} 人</div>'
 '</div>`;}).join(\'\')}</div></div>\n')

s=s.replace(anchor, block+anchor)
open(p,"w",encoding="utf-8").write(s)
print("inserted, len=",len(s))
