import { useEffect, useRef } from 'react'
import type { Actor } from '../domain/types'
import { Avatar } from './avatar'
import { BackIcon, ChevronRightIcon, SmileIcon } from './icons'

export function AgentProfile({ actor, close, edit, openMedia }: {
  actor: Actor; close: () => void; edit: () => void; openMedia: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    dialog.current?.showModal()
    return () => { if (dialog.current?.open) dialog.current.close() }
  }, [])

  const status = actor.archived ? '已归档' : actor.enabled ? '已启用' : '已停用'

  return <dialog ref={dialog} className="agent-profile-dialog" aria-label={`${actor.name}的角色资料`}
    onCancel={event => { event.preventDefault(); close() }}
    onClick={event => { if (event.target === event.currentTarget) close() }}>
    <div className="agent-profile-page">
      <header className="agent-profile-header">
        <button type="button" className="icon-button" aria-label="返回聊天" onClick={close}><BackIcon /></button>
        <h2>角色资料</h2>
        <span aria-hidden="true" />
      </header>
      <div className="agent-profile-body">
        <section className="agent-profile-identity">
          <div className="agent-profile-cover" aria-hidden="true" />
          <div className="agent-profile-person">
            <Avatar actor={actor} size={82} showStatus={false} />
            <div>
              <h1>{actor.name}</h1>
              <span className={'agent-profile-status' + (actor.enabled && !actor.archived ? ' active' : '')}>
                <i />{status}
              </span>
            </div>
          </div>
          <div className="agent-profile-bio">
            <span>简介</span>
            <p>{actor.bio.trim() || '这个角色还没有填写简介。'}</p>
          </div>
        </section>

        {actor.speakingStyle.trim() && <section className="agent-profile-card">
          <span>说话风格</span><p>{actor.speakingStyle}</p>
        </section>}
        {actor.persona.trim() && <details className="agent-profile-card agent-profile-details">
          <summary>角色设定<ChevronRightIcon /></summary>
          <p>{actor.persona}</p>
        </details>}
        <button type="button" className="agent-profile-link" onClick={openMedia}>
          <span className="agent-profile-link-icon"><SmileIcon /></span>
          <span><strong>图片、语音与表情</strong><small>查看和管理角色的多媒体表现</small></span>
          <ChevronRightIcon />
        </button>
      </div>
      <footer className="agent-profile-footer">
        <button type="button" className="btn-secondary" onClick={close}>返回聊天</button>
        <button type="button" className="btn-primary" onClick={edit}>编辑资料</button>
      </footer>
    </div>
  </dialog>
}
