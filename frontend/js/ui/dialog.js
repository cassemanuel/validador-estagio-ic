/**
 * Modais de confirmação/aviso baseados no <dialog id="modal-confirmar">.
 * Substituem window.prompt/confirm/alert em toda a aplicação.
 */

/**
 * Modal de confirmação estilizado.
 * @param {object} op
 * @param {string} op.titulo Título do dialog.
 * @param {string} [op.mensagem] Texto explicativo.
 * @param {boolean} [op.comMotivo] Se true, exibe textarea de justificativa
 *   e retorna o texto digitado; se false, retorna true/null.
 * @param {string} [op.labelOk] Rótulo do botão de confirmação.
 * @returns {Promise<string|boolean|null>} Texto do motivo, true (confirmado)
 *   sem motivo, ou null (cancelado — inclusive via Esc ou clique fora).
 */
export function dialogConfirmar({ titulo, mensagem, comMotivo = true, labelOk = 'Confirmar' }) {
  const modal = document.getElementById('modal-confirmar');
  const h2 = document.getElementById('modal-confirmar-titulo');
  const msg = document.getElementById('modal-confirmar-msg');
  const motivo = document.getElementById('modal-confirmar-motivo');
  const btnOk = document.getElementById('modal-confirmar-ok');
  const btnCancel = document.getElementById('modal-confirmar-cancel');
  const btnFechar = document.getElementById('modal-confirmar-fechar');
  if (!modal) return Promise.resolve(null);

  h2.textContent = titulo;
  msg.textContent = mensagem || '';
  msg.hidden = !mensagem;
  motivo.hidden = !comMotivo;
  motivo.value = '';
  motivo.classList.remove('input-erro');
  motivo.oninput = () => motivo.classList.remove('input-erro');
  btnOk.textContent = labelOk;

  // Devolve o foco a quem abriu o modal (se ainda estiver na página).
  const origemFoco = document.activeElement;

  return new Promise((resolve) => {
    let resultado = null;
    const fechar = (valor) => {
      resultado = valor;
      modal.close();
    };
    // Único ponto de resolução: cobre botões, clique fora e Esc (o evento
    // nativo `cancel` fecha o dialog e dispara `close`).
    modal.onclose = () => {
      modal.onclose = null;
      if (origemFoco instanceof HTMLElement && origemFoco.isConnected) {
        origemFoco.focus();
      }
      resolve(resultado);
    };
    btnOk.onclick = () => {
      const texto = motivo.value.trim();
      if (comMotivo && !texto) {
        motivo.focus();
        motivo.classList.add('input-erro');
        return;
      }
      fechar(comMotivo ? texto : true);
    };
    btnCancel.onclick = () => fechar(null);
    btnFechar.onclick = () => fechar(null);
    modal.onclick = (e) => { if (e.target === modal) fechar(null); };
    modal.showModal();
    if (comMotivo) motivo.focus();
  });
}

/** Modal de aviso (substitui window.alert). */
export function dialogAviso(titulo, mensagem) {
  return dialogConfirmar({ titulo, mensagem, comMotivo: false, labelOk: 'Entendi' });
}
