# ConfScope 生产确认流程优化说明

## 1. 本次优化目标

本次只处理 **ApplyPlan 生产环境确认与“执行变更”按钮无法启用的问题**。

**暂不处理“来源环境 = 目标环境”的原地修改问题。**

当前使用 ConfScope 对 Nacos 配置进行批量替换，在 ApplyPlan 页面已经完成：

- 选择变更项
- Diff 查看
- Dry-run 检查
- Dry-run 检查成功

但在生产确认环节，即使把页面提示的确认文本完整复制到输入框，**“执行变更”按钮仍然保持禁用状态**。

同时，当前确认方式过于复杂：要求用户完整输入类似下面的长文本：

```text
APPLY plan_mto4nkxp_g6e61s TO 广垦公寓 / 生产 / 目标环境 / yozuyun
```

这个交互不适合日常运维使用。

---

## 2. 当前问题

当前页面逻辑主要位于：

```text
src/components/ApplyPlanView.tsx
```

生产目标会要求强确认，核心逻辑类似：

```ts
const requiredText = applyConfirmationText(plan);

const ready = protectedTarget
  ? confirmationText === requiredText
  : confirmed;

const executeDisabled =
  !ready ||
  anyRunning ||
  executionSucceeded ||
  selectedCount === 0 ||
  selectedHasBlocked;
```

确认文本生成逻辑位于：

```text
src/lib/applyPlanExecution.ts
```

类似：

```ts
export function applyConfirmationText(plan) {
  return `APPLY ${plan.id} TO ${plan.target.label}`;
}
```

### 当前存在两个问题

#### 问题 1：确认交互太复杂

用户需要人工复制或输入完整的：

```text
APPLY + planId + TO + targetLabel
```

文本很长，包含中文、空格、斜杠等内容，容易出现：

- 多余空格
- 全角空格
- 不可见字符
- WebView 输入事件差异
- 剪贴板文本差异

这对运维人员没有实际价值，只增加操作成本。

#### 问题 2：按钮禁用原因不可见

当前只看到“执行变更”按钮变灰，但页面没有告诉用户到底是哪一个条件没有满足。

例如可能是：

- 确认文本未匹配
- 没有选择变更项
- 存在 blocked 项
- 已有任务执行中
- 当前计划已经执行成功

用户无法快速判断。

---

# 3. 优化要求

## 3.1 简化生产确认方式

生产环境仍然必须保留强确认，**不能直接删除生产保护逻辑**。

但不要再要求用户输入完整的长文本。

建议改为只输入一个简短固定确认词：

```text
APPLY
```

或者中文：

```text
确认执行
```

推荐最终采用：

```text
APPLY
```

原因：

- 简短
- 不受 targetLabel、中文、空格影响
- 仍然属于主动确认
- 操作成本低

页面展示目标环境，让用户确认修改对象：

```text
目标：广垦公寓 / 生产 / 目标环境 / yozuyun

请输入 APPLY 确认执行：
[                    ]
```

只有输入：

```text
APPLY
```

才允许执行。

---

## 3.2 输入校验要做简单容错

建议：

```ts
const normalizedConfirmation = confirmationText.trim().toUpperCase();
const ready = protectedTarget
  ? normalizedConfirmation === "APPLY"
  : confirmed;
```

允许：

```text
APPLY
 apply
Apply
 APPLY 
```

最终都识别为有效确认。

不要继续依赖：

```text
planId + targetLabel
```

作为输入文本的一部分。

planId、targetLabel 仍然应显示在页面上，但只作为信息展示和审计内容，不作为用户输入校验内容。

---

# 4. 页面交互建议

修改前：

```text
输入以下文本以启用执行：

APPLY plan_xxx TO 广垦公寓 / 生产 / 目标环境 / yozuyun

[ 输入完整确认文本 ]

[Dry-run 检查] [执行变更]
```

修改后：

```text
生产变更确认

目标环境：
广垦公寓 / 生产 / 目标环境 / yozuyun

计划 ID：
plan_mto4nkxp_g6e61s

Dry-run：检查通过，计划写入 1 项

请输入 APPLY 确认执行：
[ APPLY ]

✓ 已确认生产变更

[Dry-run 检查] [执行变更]
```

当输入错误时显示：

```text
请输入 APPLY 后才能执行生产变更
```

不要只让按钮变灰。

---

# 5. 明确显示按钮禁用原因

在 `ConfirmationPanel` 中增加执行条件说明。

例如：

```ts
const disabledReasons: string[] = [];

if (!ready) {
  disabledReasons.push("请输入 APPLY 确认生产变更");
}

if (anyRunning) {
  disabledReasons.push("当前已有任务正在执行");
}

if (executionSucceeded) {
  disabledReasons.push("当前变更计划已经执行成功");
}

if (selectedCount === 0) {
  disabledReasons.push("没有选择可执行的变更项");
}

if (selectedHasBlocked) {
  disabledReasons.push("所选变更项中存在被阻断项");
}
```

页面显示：

```text
无法执行：请输入 APPLY 确认生产变更
```

如果可以执行，则显示：

```text
✓ 已满足执行条件
```

---

# 6. 建议修改位置

## 6.1 主要修改文件

```text
src/components/ApplyPlanView.tsx
```

重点修改：

```text
ConfirmationPanel
```

涉及：

```text
requiredText
ready
executeDisabled
confirmationText
确认输入框
按钮禁用原因提示
```

### 建议逻辑

```ts
const normalizedConfirmation = confirmationText.trim().toUpperCase();

const ready = protectedTarget
  ? normalizedConfirmation === "APPLY"
  : confirmed;
```

生产目标展示：

```tsx
<div className="field">
  <label className="field-label">生产变更确认</label>

  <div className="field-hint">
    目标：{plan.target.label}
  </div>

  <div className="field-hint">
    计划 ID：{plan.id}
  </div>

  <div className="field-hint">
    请输入 APPLY 确认执行
  </div>

  <input
    value={confirmationText}
    onChange={(event) => onConfirmationTextChange(event.target.value)}
    placeholder="APPLY"
  />
</div>
```

---

## 6.2 `applyConfirmationText` 的处理

文件：

```text
src/lib/applyPlanExecution.ts
```

当前函数如果仍用于审计、日志或 UI 展示，可以保留：

```ts
applyConfirmationText(plan)
```

但**不要再用它作为输入框必须逐字匹配的执行条件**。

也就是说：

```text
完整确认文本：用于展示 / 审计
APPLY：用于用户执行确认
```

不要影响现有 ApplyPlan、Backup、Dry-run、Freshness、审计等逻辑。

---

# 7. 不允许做的修改

本次优化不要：

- 删除生产环境保护
- 删除 Dry-run
- 删除 Before Backup
- 删除 Freshness 校验
- 删除 ApplyPlan
- 绕过 executeApplyPlan
- 直接调用 Nacos 发布接口跳过安全链路
- 修改 Nacos 数据库
- 修改“来源=目标”的逻辑

本次只优化：

```text
生产确认输入方式 + 执行按钮状态提示
```

---

# 8. 测试要求

## 测试 1：生产环境默认不能直接执行

进入生产 ApplyPlan 页面。

未输入确认词。

预期：

```text
执行变更按钮不可用
```

同时显示：

```text
请输入 APPLY 确认生产变更
```

---

## 测试 2：输入 APPLY

输入：

```text
APPLY
```

前提：

- 已选择至少 1 个可执行项
- 无 blocked 项
- 当前没有任务执行
- 当前计划尚未执行成功

预期：

```text
✓ 已满足执行条件
```

并且：

```text
执行变更按钮立即可用
```

---

## 测试 3：大小写和空格容错

依次测试：

```text
apply
Apply
 APPLY 
```

预期：

全部可以通过确认。

---

## 测试 4：错误确认词

输入：

```text
YES
CONFIRM
APP
```

预期：

```text
执行变更按钮不可用
```

并显示：

```text
请输入 APPLY 确认生产变更
```

---

## 测试 5：Dry-run 后执行

执行：

```text
Dry-run 检查
```

结果：

```text
Dry-run 检查通过，计划写入 1 项
```

然后输入：

```text
APPLY
```

预期：

```text
执行变更按钮可用
```

点击后正常进入现有执行流程。

---

## 测试 6：其他禁用条件提示

分别模拟：

### 没有选择变更项

显示：

```text
无法执行：没有选择可执行的变更项
```

### 存在被阻断项

显示：

```text
无法执行：所选变更项中存在被阻断项
```

### 任务执行中

显示：

```text
无法执行：当前已有任务正在执行
```

---

# 9. 自动化测试

重点补充：

```text
src/components/ApplyPlanView.test.tsx
```

至少新增以下测试：

1. protectedTarget + confirmationText="" → 执行按钮 disabled
2. protectedTarget + confirmationText="APPLY" → 执行按钮 enabled
3. confirmationText=" apply " → enabled
4. confirmationText="YES" → disabled
5. selectedCount=0 → disabled，并显示原因
6. selectedHasBlocked=true → disabled，并显示原因
7. Dry-run 成功后输入 APPLY → 执行按钮仍可正常启用

---

# 10. 最终验收标准

最终生产确认流程必须达到：

```text
进入 ApplyPlan
    ↓
查看目标环境和 Plan ID
    ↓
Dry-run 检查
    ↓
检查通过
    ↓
输入 APPLY
    ↓
显示“已满足执行条件”
    ↓
执行变更按钮可点击
    ↓
继续走原有 Backup / Freshness / OpenAPI 发布流程
```

核心目标：

> 保留生产安全确认，但把确认方式简化为输入 `APPLY`，并明确告诉用户为什么当前不能执行。

不要再要求用户复制：

```text
APPLY plan_xxx TO xxx / xxx / xxx
```

这种长确认文本。
