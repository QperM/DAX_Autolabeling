import React from 'react';

type BatchDepthCompletionButtonProps = {
  disabled?: boolean;
  running?: boolean;
  onClick: () => void | Promise<void>;
  title?: string;
};

const BatchDepthCompletionButton: React.FC<BatchDepthCompletionButtonProps> = ({
  disabled = false,
  running = false,
  onClick,
  title,
}) => {
  return (
    <button
      type="button"
      className="ai-annotation-btn ai-depth-repair-btn"
      onClick={onClick}
      disabled={disabled || running}
      title={title ?? '按图片顺序批量补全深度信息（调用 depthrepair-service，产物写入项目 depth 目录）'}
    >
      {running ? '🛠️ 批量补全深度信息进行中...' : '🛠️ 批量补全深度信息'}
    </button>
  );
};

export default BatchDepthCompletionButton;
