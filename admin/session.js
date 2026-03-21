/* ===============================
ADMIN SESSION PROTECTION
================================ */

function getSession(){

return JSON.parse(localStorage.getItem("salonSession")) ||
       JSON.parse(sessionStorage.getItem("salonSession"));

}

function checkAdminSession(){

const session = getSession();

if(!session || session.role !== "admin"){
window.location.replace("../log_in.html");
}

}

/* run check immediately */

checkAdminSession();


/* ===============================
PREVENT BACK / FORWARD CACHE
================================ */

window.addEventListener("pageshow", function(event){

if(event.persisted){
location.reload();
}

checkAdminSession();

});


/* ===============================
CHECK SESSION WHEN TAB ACTIVE
================================ */

document.addEventListener("visibilitychange", function(){

if(document.visibilityState === "visible"){
checkAdminSession();
}

});