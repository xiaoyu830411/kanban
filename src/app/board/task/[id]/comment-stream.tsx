interface CommentItem {
  id: number;
  kind: 'comment' | 'report';
  author: string;
  authorType: 'member' | 'agent';
  body: string;
  changedFiles: string[];
  createdAt: string;
}

/** 评论与报告流（报告含改动文件列表）。 */
export function CommentStream({ comments }: { comments: CommentItem[] }) {
  if (comments.length === 0) {
    return <p className="text-sm text-neutral-400">暂无评论或报告。</p>;
  }
  return (
    <ol className="flex flex-col gap-4">
      {comments.map((comment) => (
        <li key={comment.id} className="border-l-2 border-neutral-200 pl-3">
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <span className={comment.authorType === 'agent' ? 'font-medium text-violet-600' : 'font-medium text-neutral-700'}>
              {comment.author}
            </span>
            {comment.kind === 'report' && (
              <span className="rounded bg-violet-100 px-1.5 py-0.5 text-violet-700">执行报告</span>
            )}
            <time>{new Date(comment.createdAt).toLocaleString('zh-CN')}</time>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-800">{comment.body}</p>
          {comment.kind === 'report' && comment.changedFiles.length > 0 && (
            <div className="mt-1 rounded bg-neutral-50 px-2 py-1">
              <p className="text-xs font-medium text-neutral-500">改动文件：</p>
              <ul className="mt-0.5 list-inside list-disc font-mono text-xs text-neutral-600">
                {comment.changedFiles.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
