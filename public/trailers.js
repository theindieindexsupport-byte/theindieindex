document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('submissionForm');
    const feedback = document.getElementById('formFeedback');

    // COLOQUE A SUA URL DO FORMSPREE AQUI EMBAIXO:
    const formspreeURL = "https://formspree.io/f/mdajwgnn"; 

    form.addEventListener('submit', async (e) => {
        // Previne o comportamento padrão de recarregar a página
        e.preventDefault();

        // Verifica se a checkbox das regras foi marcada
        const rulesChecked = document.getElementById('rulesCheck').checked;

        if (!rulesChecked) {
            alert('You must confirm that you followed the submission protocol.');
            return;
        }

        // Muda o texto do botão para mostrar que está carregando
        const submitBtn = form.querySelector('.btn-submit');
        const originalBtnText = submitBtn.innerText;
        submitBtn.innerText = "Sending...";
        submitBtn.disabled = true;

        // Coleta os dados do formulário
        const formData = new FormData(form);

        try {
            // Envia os dados para o Formspree
            const response = await fetch(formspreeURL, {
                method: 'POST',
                body: formData,
                headers: {
                    'Accept': 'application/json'
                }
            });

            if (response.ok) {
                // Sucesso! Limpa o formulário e exibe a mensagem
                form.reset();
                form.style.display = 'none';
                
                feedback.classList.remove('hidden');
                feedback.classList.add('feedback-msg');
                feedback.innerHTML = `
                    <h3>Submission Received!</h3>
                    <p>Your project has been submitted to The Indie Index. Our team will review the material shortly. Keep an eye on your inbox.</p>
                `;
            } else {
                // Caso o Formspree retorne algum erro (ex: limite mensal atingido)
                alert("Oops! There was a problem submitting your form. Please try again later.");
                submitBtn.innerText = originalBtnText;
                submitBtn.disabled = false;
            }
        } catch (error) {
            // Caso dê erro de conexão/internet
            alert("Oops! There was a network error. Please check your connection and try again.");
            submitBtn.innerText = originalBtnText;
            submitBtn.disabled = false;
        }
    });
});