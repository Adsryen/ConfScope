package task

import (
	"testing"
	"time"
)

func TestTaskManager_CreateAndGet(t *testing.T) {
	mgr := NewTaskManager()

	task := mgr.CreateTask("导出配置", TaskTypeExport)
	if task.ID == "" {
		t.Error("任务 ID 不能为空")
	}
	if task.Name != "导出配置" {
		t.Errorf("任务名称不匹配: %s", task.Name)
	}
	if task.Status != TaskStatusPending {
		t.Errorf("任务状态应为 pending: %s", task.Status)
	}

	// 获取任务
	got, ok := mgr.GetTask(task.ID)
	if !ok {
		t.Error("获取任务失败")
	}
	if got.ID != task.ID {
		t.Errorf("任务 ID 不匹配: %s != %s", got.ID, task.ID)
	}
}

func TestTaskManager_StartAndComplete(t *testing.T) {
	mgr := NewTaskManager()

	task := mgr.CreateTask("备份配置", TaskTypeBackup)

	// 开始任务
	if err := mgr.StartTask(task.ID); err != nil {
		t.Fatalf("开始任务失败: %v", err)
	}

	updated, _ := mgr.GetTask(task.ID)
	if updated.Status != TaskStatusRunning {
		t.Errorf("任务状态应为 running: %s", updated.Status)
	}

	// 更新进度
	if err := mgr.UpdateProgress(task.ID, 5, 0); err != nil {
		t.Fatalf("更新进度失败: %v", err)
	}

	updated, _ = mgr.GetTask(task.ID)
	if updated.Completed != 5 {
		t.Errorf("已完成数不匹配: %d", updated.Completed)
	}

	// 完成任务
	if err := mgr.CompleteTask(task.ID, true, ""); err != nil {
		t.Fatalf("完成任务失败: %v", err)
	}

	updated, _ = mgr.GetTask(task.ID)
	if updated.Status != TaskStatusSuccess {
		t.Errorf("任务状态应为 success: %s", updated.Status)
	}
	if updated.Progress != 100 {
		t.Errorf("进度应为 100: %d", updated.Progress)
	}
}

func TestTaskManager_FailTask(t *testing.T) {
	mgr := NewTaskManager()

	task := mgr.CreateTask("应用配置", TaskTypeApply)
	mgr.StartTask(task.ID)

	// 失败任务
	if err := mgr.CompleteTask(task.ID, false, "网络错误"); err != nil {
		t.Fatalf("失败任务出错: %v", err)
	}

	updated, _ := mgr.GetTask(task.ID)
	if updated.Status != TaskStatusFailed {
		t.Errorf("任务状态应为 failed: %s", updated.Status)
	}
	if updated.Error != "网络错误" {
		t.Errorf("错误信息不匹配: %s", updated.Error)
	}
}

func TestTaskManager_CancelTask(t *testing.T) {
	mgr := NewTaskManager()

	task := mgr.CreateTask("恢复配置", TaskTypeRestore)
	mgr.StartTask(task.ID)

	// 取消任务
	if err := mgr.CancelTask(task.ID); err != nil {
		t.Fatalf("取消任务失败: %v", err)
	}

	updated, _ := mgr.GetTask(task.ID)
	if updated.Status != TaskStatusCancelled {
		t.Errorf("任务状态应为 cancelled: %s", updated.Status)
	}

	// 验证取消信号
	if !mgr.IsCancelled(task.ID) {
		t.Error("IsCancelled 应返回 true")
	}
}

func TestTaskManager_ListTasks(t *testing.T) {
	mgr := NewTaskManager()

	mgr.CreateTask("任务1", TaskTypeExport)
	mgr.CreateTask("任务2", TaskTypeBackup)
	mgr.CreateTask("任务3", TaskTypeApply)

	tasks := mgr.ListTasks()
	if len(tasks) != 3 {
		t.Errorf("任务数量不匹配: %d", len(tasks))
	}
}

func TestTaskManager_DeleteTask(t *testing.T) {
	mgr := NewTaskManager()

	task := mgr.CreateTask("测试任务", TaskTypeExport)

	// 删除待执行的任务
	if err := mgr.DeleteTask(task.ID); err != nil {
		t.Fatalf("删除任务失败: %v", err)
	}

	_, ok := mgr.GetTask(task.ID)
	if ok {
		t.Error("任务应该已被删除")
	}
}

func TestTaskManager_ClearCompleted(t *testing.T) {
	mgr := NewTaskManager()

	task1 := mgr.CreateTask("成功任务", TaskTypeExport)
	task2 := mgr.CreateTask("失败任务", TaskTypeBackup)
	task3 := mgr.CreateTask("运行中任务", TaskTypeApply)

	mgr.StartTask(task1.ID)
	mgr.CompleteTask(task1.ID, true, "")

	mgr.StartTask(task2.ID)
	mgr.CompleteTask(task2.ID, false, "错误")

	mgr.StartTask(task3.ID)

	mgr.ClearCompleted()

	tasks := mgr.ListTasks()
	if len(tasks) != 1 {
		t.Errorf("剩余任务数量不匹配: %d", len(tasks))
	}
	if len(tasks) > 0 && tasks[0].ID != task3.ID {
		t.Error("剩余任务应该是运行中的任务")
	}
}

func TestTaskManager_ElapsedTime(t *testing.T) {
	mgr := NewTaskManager()

	task := mgr.CreateTask("测试耗时", TaskTypeExport)
	mgr.StartTask(task.ID)

	time.Sleep(10 * time.Millisecond)

	mgr.CompleteTask(task.ID, true, "")

	updated, _ := mgr.GetTask(task.ID)
	if updated.ElapsedTime < 10 {
		t.Errorf("耗时应大于 10ms: %d", updated.ElapsedTime)
	}
}
