function passSecurityChecker(password){
    if(password.length >=8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password)) {
        return true;
    }
    else{
        return false;
    }
}
module.exports = passSecurityChecker;
